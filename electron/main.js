const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  ipcMain,
} = require('electron');
const { execFile, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// Auto-updater (lazy import — unavailable in dev)
// ---------------------------------------------------------------------------
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  // Not available outside a packaged build — ignored silently
}

// ---------------------------------------------------------------------------
// AppImage Sandbox Escape
//
// When running as an AppImage on Linux, Electron injects its own bundled
// libraries into LD_LIBRARY_PATH. This breaks external CLI tools like NAPS2
// and scanimage that link against system libraries. Stripping the variable
// lets child processes inherit the host's clean library search path.
// ---------------------------------------------------------------------------
function getCleanEnv() {
  const cleanEnv = { ...process.env };
  if (cleanEnv.APPIMAGE) {
    delete cleanEnv.LD_LIBRARY_PATH;
  }
  return cleanEnv;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let setupWindow = null;
let tray = null;
let isQuitting = false;
let triggerServer = null;
let store = null; // Initialized async in app.whenReady() via dynamic import

// Async scan job tracking — polled by the web app via GET /status
const scanJobs = {};
// Shape: { [scanId]: { status: 'scanning'|'ready'|'error', data: string|null, error: string|null, createdAt: number, abortController: AbortController|null } }

// Hardware concurrency guard — scanners cannot handle parallel requests
let scanInProgress = false;

const isDev = !app.isPackaged;
const TRIGGER_PORT = 3002;
const JOB_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes — stale jobs are purged
const SCAN_TIMEOUT_MS = 300000;        // 5 minutes — accommodates large ADF stacks

// ---------------------------------------------------------------------------
// Single Instance Lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // If a second instance is launched, surface the setup window (if it exists)
    if (setupWindow && !setupWindow.isDestroyed()) {
      if (setupWindow.isMinimized()) setupWindow.restore();
      setupWindow.show();
      setupWindow.focus();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCANNER HARDWARE BRIDGE (Pure Node.js)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns the correct NAPS2 CLI command, base arguments, and driver flag
 * for the current OS.
 */
function getNaps2Info() {
  const platform = process.platform;
  if (platform === 'win32') {
    // 1. Cached portable install (set by setup:install-engine)
    const cached = store && store.get('naps2PortablePath');
    if (cached && fs.existsSync(cached)) {
      return { cmd: cached, args: [], driver: 'wia' };
    }
    // 2. System install
    const primary = 'C:\\Program Files\\NAPS2\\naps2.console.exe';
    const fallback = 'C:\\Program Files (x86)\\NAPS2\\naps2.console.exe';
    const cmd = fs.existsSync(primary) ? primary : fallback;
    return { cmd, args: [], driver: 'wia' };
  }
  if (platform === 'darwin') {
    return { cmd: '/Applications/NAPS2.app/Contents/MacOS/naps2', args: ['console'], driver: 'apple' };
  }
  // Linux
  const cmd = fs.existsSync('/usr/bin/naps2') ? '/usr/bin/naps2' : 'naps2';
  return { cmd, args: ['console'], driver: 'sane' };
}

/**
 * List available scanners via NAPS2.
 * Includes a strict 30-second timeout to allow Wi-Fi scanners to reply.
 *
 * Returns one of:
 * { success: true,  scanners: string[] }   — discovery completed (list may be empty)
 * { success: false, error: 'engine_missing' }  — NAPS2 binary is not on disk or vanished mid-call
 * { success: false, error: 'discovery_failed', message: string }  — other failure (timeout, etc.)
 */
async function listScanners() {
  const { cmd, args, driver } = getNaps2Info();

  // Strict pre-check: if the binary isn't on disk, there's no point spawning.
  if (!fs.existsSync(cmd)) {
    console.error(`[Scanner] Engine missing at expected path: ${cmd}`);
    return { success: false, error: 'engine_missing' };
  }

  const fullArgs = [...args, '--driver', driver, '--listdevices'];
  console.log(`[Scanner] Discovering: ${cmd} ${fullArgs.join(' ')}`);

  try {
    const { stdout } = await execFileAsync(cmd, fullArgs, {
      timeout: 30000,
      env: getCleanEnv(),
    });

    const noiseKeywords = ['NAPS2', 'Copyright', '--driver', 'option must be', 'Possible values'];

    const scanners = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !noiseKeywords.some((kw) => line.includes(kw)));

    return { success: true, scanners: [...new Set(scanners)] };
  } catch (err) {
    // ENOENT means the binary disappeared between the existsSync check and exec —
    // treat it identically to a pre-check miss so the wizard can route the user
    // back to the gatekeeper.
    if (err && (err.code === 'ENOENT' || /ENOENT/i.test(err.message || ''))) {
      console.error('[Scanner] Engine vanished during exec:', err.message);
      return { success: false, error: 'engine_missing' };
    }
    console.error('[Scanner] Failed to list devices:', err.message);
    return { success: false, error: 'discovery_failed', message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Pre-Flight Check — Ghost Device Prevention
//
// Before physically scanning, verify the saved scanner is online.
// Prevents silent hangs when a USB device is unplugged or a Wi-Fi scanner
// is powered off.
// ---------------------------------------------------------------------------
async function preFlightCheck(scanId) {
  const savedScanner = store.get('defaultScanner');

  if (!savedScanner) {
    scanJobs[scanId].status = 'error';
    scanJobs[scanId].error = 'No default scanner configured. Please set one via the system tray.';
    return false;
  }

  console.log(`[PreFlight] Verifying scanner is online: "${savedScanner}"`);
  const result = await listScanners();
  console.log(`[PreFlight] Discovery result:`, result);

  // Engine missing → cannot scan at all. Surface a distinct error so the user
  // knows to reinstall NAPS2 from the wizard rather than fiddling with hardware.
  if (!result.success && result.error === 'engine_missing') {
    const errorMsg = 'Scan engine missing. Please reinstall NAPS2 from the system tray (Change Scanner…).';
    scanJobs[scanId].status = 'error';
    scanJobs[scanId].error = errorMsg;
    dialog.showErrorBox(
      'Scan Engine Missing',
      'The NAPS2 scan engine is no longer installed on this system.\n\n' +
      'Open the wizard from the system tray ("Change Scanner…") to reinstall it.'
    );
    return false;
  }

  // Other discovery failure (timeout, etc.)
  if (!result.success) {
    const errorMsg = 'Scanner discovery failed: ' + (result.message || 'unknown error');
    scanJobs[scanId].status = 'error';
    scanJobs[scanId].error = errorMsg;
    dialog.showErrorBox('Scanner Error', errorMsg);
    return false;
  }

  const devices = result.scanners;

  // Fuzzy match — NAPS2 device strings can vary slightly between discovery runs
  const found = devices.some(
    (d) => d === savedScanner || d.includes(savedScanner) || savedScanner.includes(d)
  );

  if (!found) {
    const errorMsg = 'Scanner offline or disconnected. Please check the device and try again.';
    scanJobs[scanId].status = 'error';
    scanJobs[scanId].error = errorMsg;

    // Native OS alert — visible even when the app has no window
    dialog.showErrorBox(
      'Scanner Error',
      `The configured scanner "${savedScanner}" was not found.\n\n` +
      `Detected devices:\n${devices.join('\n') || '(none)'}\n\n` +
      `Please check the connection and try again.`
    );
    return false;
  }

  console.log(`[PreFlight] Scanner verified online.`);
  return true;
}

// ---------------------------------------------------------------------------
// Multi-Page PDF Scan via NAPS2
//
// Outputs a .pdf file — NAPS2 auto-detects the paper source (ADF or flatbed)
// based on hardware capability. No --source flag is used so that scanners
// without an ADF gracefully fall back to flatbed glass.
//
// Timeout is 5 minutes (300 000 ms) to accommodate large document stacks
// fed through an Automatic Document Feeder.
// ---------------------------------------------------------------------------
async function scanDocumentPdf(deviceName, abortSignal) {
  const tmpFile = path.join(
    os.tmpdir(),
    `dims-scanner_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
  );

  // Remove any stale file at this path
  if (fs.existsSync(tmpFile)) {
    try { fs.unlinkSync(tmpFile); } catch { /* no-op */ }
  }

  try {
    // ── Test devices: scanimage → PNG → wrap in PDF via pdf-lib ──────
    if (deviceName && (deviceName.toLowerCase().startsWith('test:') || deviceName.includes('frontend-tester'))) {
      const saneDevice = deviceName.startsWith('test:') ? deviceName : 'test:0';
      console.log(`[Scanner] Routing test device to scanimage: ${saneDevice}`);

      const tmpPng = tmpFile.replace('.pdf', '.png');

      await execFileAsync(
        'scanimage',
        ['-d', saneDevice, '--format=png', '-o', tmpPng],
        { timeout: 30000, env: getCleanEnv(), signal: abortSignal }
      );

      // Wrap the scanned PNG in a single-page PDF (pdf-lib is CJS-compatible)
      const { PDFDocument } = require('pdf-lib');
      const pngBytes = fs.readFileSync(tmpPng);
      const pdfDoc = await PDFDocument.create();
      const pngImage = await pdfDoc.embedPng(pngBytes);
      const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
      page.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });
      const pdfBytes = await pdfDoc.save();
      fs.writeFileSync(tmpFile, Buffer.from(pdfBytes));

      // Clean up intermediate PNG
      try { fs.unlinkSync(tmpPng); } catch { /* no-op */ }
    }
    // ── Physical hardware: NAPS2 → direct PDF output ─────────────────
    else {
      const { cmd, args, driver } = getNaps2Info();
      const fullArgs = [
        ...args,
        '-o', tmpFile,       // .pdf extension tells NAPS2 to output PDF
        '--noprofile',
        '--driver', driver,
      ];

      if (deviceName && deviceName.trim()) {
        fullArgs.push('--device', deviceName.trim());
      }

      console.log(`[Scanner] Executing: ${cmd} ${fullArgs.join(' ')}`);

      await execFileAsync(cmd, fullArgs, {
        timeout: SCAN_TIMEOUT_MS,
        env: getCleanEnv(),
        signal: abortSignal,
      });
    }

    // Verify the output file was created and is non-empty
    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      throw new Error('Scanner produced an empty or missing file. Check hardware connection.');
    }

    // Read and encode as a base64 data-URL
    const pdfBuffer = fs.readFileSync(tmpFile);
    return `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;

  } finally {
    // Always clean up temp files — never leave scan data on disk
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch { /* no-op */ }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  NAPS2 AUTO-INSTALL
//
//  Downloads the latest NAPS2 release from GitHub and installs/extracts it
//  appropriately for the current OS. Streams progress events back to the
//  renderer via `setup:install-engine:progress`.
// ═══════════════════════════════════════════════════════════════════════════

const NAPS2_RELEASES_API = 'https://api.github.com/repos/cyanfish/naps2/releases/latest';
const INSTALL_POLL_INTERVAL_MS = 2000;
const INSTALL_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min wait for user-driven installer

/**
 * GET a JSON or binary URL with manual one-level 302 handling.
 * Resolves with { res, finalUrl } where `res` is the IncomingMessage
 * positioned at the final destination.
 */
function httpsGetWithRedirect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const doGet = (currentUrl, hop) => {
      if (hop > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const req = https.get(currentUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // discard body
          const next = new URL(res.headers.location, currentUrl).toString();
          doGet(next, hop + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          return;
        }
        resolve({ res, finalUrl: currentUrl });
      });
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

/**
 * Fetch and parse the latest NAPS2 release metadata from GitHub.
 */
async function fetchLatestNaps2Release() {
  const { res } = await httpsGetWithRedirect(NAPS2_RELEASES_API, {
    'User-Agent': 'dims-scanner',
    'Accept': 'application/vnd.github+json',
  });
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Failed to parse GitHub release JSON: ' + err.message));
      }
    });
    res.on('error', reject);
  });
}

/**
 * Stream-download a URL to a destination file, emitting progress events.
 */
function downloadToFile(url, destPath, onProgress) {
  return new Promise(async (resolve, reject) => {
    let received = 0;
    let total = 0;
    let fileStream;
    try {
      const { res } = await httpsGetWithRedirect(url, { 'User-Agent': 'dims-scanner' });
      total = parseInt(res.headers['content-length'] || '0', 10);
      fileStream = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) {
          const percent = total > 0 ? Math.floor((received / total) * 100) : -1;
          onProgress({ received, total, percent });
        }
      });

      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve({ received, total })));
      fileStream.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch { /* no-op */ }
        reject(err);
      });
      res.on('error', (err) => {
        try { fileStream.close(); } catch { /* no-op */ }
        try { fs.unlinkSync(destPath); } catch { /* no-op */ }
        reject(err);
      });
    } catch (err) {
      if (fileStream) {
        try { fileStream.close(); } catch { /* no-op */ }
      }
      try { fs.unlinkSync(destPath); } catch { /* no-op */ }
      reject(err);
    }
  });
}

/**
 * Recursively walk a directory (max depth) looking for a file by basename.
 */
function findFileByName(rootDir, basename, maxDepth = 3) {
  function walk(dir, depth) {
    if (depth > maxDepth) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) return full;
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(rootDir, 0);
}

/**
 * Poll for a file's existence with a timeout. Used for user-driven installers
 * where we cannot detect completion synchronously (Installer.app, gdebi).
 */
function waitForFile(filePath, onTick) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (fs.existsSync(filePath)) {
        resolve(true);
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= INSTALL_POLL_TIMEOUT_MS) {
        resolve(false);
        return;
      }
      if (onTick) onTick({ elapsed, timeout: INSTALL_POLL_TIMEOUT_MS });
      setTimeout(check, INSTALL_POLL_INTERVAL_MS);
    };
    check();
  });
}

/**
 * Verify a NAPS2 binary works by running `--help` with a short timeout.
 * UPDATED: Ignores exit code 1 if help text is successfully printed.
 */
async function verifyNaps2Binary(cmd, args) {
  try {
    await execFileAsync(cmd, [...args, '--help'], {
      timeout: 5000,
      env: getCleanEnv(),
    });
  } catch (err) {
    // Many CLI tools (including NAPS2) return an exit code of 1 when printing help text
    // or when run without mandatory arguments. Node.js treats any non-zero exit as a crash.
    // We check if it successfully outputted text containing "NAPS2" or "Usage".
    const output = (err.stdout || '') + (err.stderr || '');
    
    if (output.toLowerCase().includes('naps2') || output.toLowerCase().includes('usage')) {
      return; // False positive error. The binary is perfectly healthy!
    }
    
    // If there is no help output, it means the binary genuinely crashed (e.g., missing DLLs).
    throw new Error(err.message || 'Unknown execution error');
  }
}

/**
 * Main install entry point. Branches per OS. Returns a resolution object
 * (never throws — errors are converted to { success: false, ... }).
 */
async function installNaps2Engine(webContents) {
  const platform = process.platform;
  const send = (payload) => {
    if (webContents && !webContents.isDestroyed()) {
      webContents.send('setup:install-engine:progress', payload);
    }
  };

  // ── Step 1: Resolve latest release ────────────────────────────────────
  send({ phase: 'resolving', percent: -1, message: 'Looking up latest NAPS2 release\u2026' });
  let release;
  try {
    release = await fetchLatestNaps2Release();
  } catch (err) {
    return { success: false, phase: 'resolving', error: 'Could not reach GitHub: ' + err.message };
  }
  const version = (release.tag_name || release.name || '').replace(/^v/, '') || 'unknown';
  send({ phase: 'resolving', percent: -1, message: `Found NAPS2 ${version}`, version });

  // Pick the right asset for this OS
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matchAsset = (predicate) => assets.find((a) => predicate(a.name || ''));

  let asset = null;
  if (platform === 'win32') {
    asset = matchAsset((n) => /win.*x64.*\.zip$/i.test(n)) || matchAsset((n) => /\.zip$/i.test(n) && /win/i.test(n));
  } else if (platform === 'darwin') {
    asset = matchAsset((n) => /mac.*univ.*\.pkg$/i.test(n)) || matchAsset((n) => /\.pkg$/i.test(n) && /mac/i.test(n));
  } else {
    asset = matchAsset((n) => /linux.*x64.*\.deb$/i.test(n)) || matchAsset((n) => /\.deb$/i.test(n));
  }

  if (!asset) {
    return {
      success: false,
      phase: 'resolving',
      error: `No suitable NAPS2 asset found for ${platform} in release ${version}.`,
    };
  }

  const downloadUrl = asset.browser_download_url;
  const userDataDir = app.getPath('userData');

  // ── Step 2: Download ──────────────────────────────────────────────────
  const ext = path.extname(asset.name) || '';
  const downloadPath = path.join(userDataDir, `naps2-installer${ext}`);

  // Remove any stale download
  if (fs.existsSync(downloadPath)) {
    try { fs.unlinkSync(downloadPath); } catch { /* no-op */ }
  }

  send({ phase: 'downloading', percent: 0, message: `Downloading ${asset.name}\u2026`, version });
  try {
    await downloadToFile(downloadUrl, downloadPath, ({ received, total, percent }) => {
      const mbR = (received / 1024 / 1024).toFixed(1);
      const mbT = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';
      send({
        phase: 'downloading',
        percent,
        message: `Downloading NAPS2 ${version} (${mbR} / ${mbT} MB)`,
        bytesReceived: received,
        bytesTotal: total,
        version,
      });
    });
  } catch (err) {
    return { success: false, phase: 'downloading', error: 'Download failed: ' + err.message };
  }

  // ── Step 3: Install / extract ─────────────────────────────────────────
  try {
    if (platform === 'win32') {
      // Extract ZIP into userData/naps2 using bundled tar.exe (Windows 10 1803+)
      const destDir = path.join(userDataDir, 'naps2');
      if (fs.existsSync(destDir)) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* no-op */ }
      }
      fs.mkdirSync(destDir, { recursive: true });

      send({ phase: 'extracting', percent: -1, message: 'Extracting archive\u2026', version });
      try {
        await execFileAsync('tar.exe', ['-xf', downloadPath, '-C', destDir], {
          timeout: 120000,
          env: getCleanEnv(),
        });
      } catch (err) {
        return {
          success: false,
          phase: 'extracting',
          error: 'Extraction failed (tar.exe required, Windows 10 1803+): ' + err.message,
        };
      }

      const resolvedCmd = findFileByName(destDir, 'naps2.console.exe', 4);
      if (!resolvedCmd) {
        return {
          success: false,
          phase: 'extracting',
          error: 'Extracted archive did not contain naps2.console.exe.',
        };
      }

      send({ phase: 'verifying', percent: -1, message: 'Verifying installation\u2026', version });
      try {
        await verifyNaps2Binary(resolvedCmd, []);
      } catch (err) {
        return { success: false, phase: 'verifying', error: 'Binary failed self-test: ' + err.message };
      }

      if (store) store.set('naps2PortablePath', resolvedCmd);
      try { fs.unlinkSync(downloadPath); } catch { /* no-op */ }

      return { success: true, version, cmd: resolvedCmd, platform };
    }

    if (platform === 'darwin') {
      // Hand off to Installer.app via `open`
      send({
        phase: 'waiting-for-user',
        percent: -1,
        message: 'Opening NAPS2 installer\u2026 please follow the prompts.',
        version,
      });
      try {
        spawn('open', [downloadPath], { detached: true, stdio: 'ignore' }).unref();
      } catch (err) {
        return { success: false, phase: 'waiting-for-user', error: 'Could not launch installer: ' + err.message };
      }

      const targetCmd = '/Applications/NAPS2.app/Contents/MacOS/naps2';
      const ok = await waitForFile(targetCmd, ({ elapsed, timeout }) => {
        const remaining = Math.max(0, Math.floor((timeout - elapsed) / 1000));
        send({
          phase: 'waiting-for-user',
          percent: -1,
          message: `Waiting for installer to complete (${remaining}s remaining)\u2026`,
          version,
        });
      });

      if (!ok) {
        return {
          success: false,
          phase: 'waiting-for-user',
          error: 'Installer was not completed within 5 minutes. The downloaded package is at: ' + downloadPath,
        };
      }

      send({ phase: 'verifying', percent: -1, message: 'Verifying installation\u2026', version });
      try {
        await verifyNaps2Binary(targetCmd, ['console']);
      } catch (err) {
        return { success: false, phase: 'verifying', error: 'Binary failed self-test: ' + err.message };
      }

      try { fs.unlinkSync(downloadPath); } catch { /* no-op */ }
      return { success: true, version, cmd: targetCmd, platform };
    }

    // ── Linux ────────────────────────────────────────────────────────────
    const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (!hasDisplay) {
      return {
        success: false,
        phase: 'waiting-for-user',
        manualUrl: downloadUrl,
        error: 'No graphical session detected. Please install manually: sudo dpkg -i ' + downloadPath,
      };
    }

    send({
      phase: 'waiting-for-user',
      percent: -1,
      message: 'Opening NAPS2 installer\u2026 please confirm the install in the dialog.',
      version,
    });
    try {
      spawn('xdg-open', [downloadPath], { detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      return {
        success: false,
        phase: 'waiting-for-user',
        manualUrl: downloadUrl,
        error: 'Could not launch xdg-open: ' + err.message + '. Please install manually: sudo dpkg -i ' + downloadPath,
      };
    }

    const targetCmd = '/usr/bin/naps2';
    const ok = await waitForFile(targetCmd, ({ elapsed, timeout }) => {
      const remaining = Math.max(0, Math.floor((timeout - elapsed) / 1000));
      send({
        phase: 'waiting-for-user',
        percent: -1,
        message: `Waiting for installer to complete (${remaining}s remaining)\u2026`,
        version,
      });
    });

    if (!ok) {
      return {
        success: false,
        phase: 'waiting-for-user',
        error: 'Installer was not completed within 5 minutes. The downloaded package is at: ' + downloadPath,
      };
    }

    send({ phase: 'verifying', percent: -1, message: 'Verifying installation\u2026', version });
    try {
      await verifyNaps2Binary(targetCmd, ['console']);
    } catch (err) {
      return { success: false, phase: 'verifying', error: 'Binary failed self-test: ' + err.message };
    }

    try { fs.unlinkSync(downloadPath); } catch { /* no-op */ }
    return { success: true, version, cmd: targetCmd, platform };

  } catch (err) {
    return { success: false, phase: 'unknown', error: err.message || String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  IPC HANDLERS
//
//  Minimal surface — only what the scanner setup window needs.
//  All scan triggering is now done via the HTTP server, not IPC.
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('scanner:list', async () => {
  return listScanners();
});

ipcMain.handle('scanner:save-default', async (_event, deviceName) => {
  if (!store) throw new Error('Store not initialized yet');

  store.set('defaultScanner', deviceName);
  store.set('isSetupComplete', true);
  console.log(`[Store] Default scanner saved: "${deviceName}"`);

  // Rebuild the tray menu to reflect the newly saved scanner name
  if (tray) buildTrayMenu();

  // Hide the setup window — the agent is now configured
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.hide();
  }

  return { success: true };
});

ipcMain.handle('setup:check-engine', async () => {
  const { cmd } = getNaps2Info();
  return { exists: fs.existsSync(cmd), os: process.platform };
});

ipcMain.handle('setup:get-state', () => {
  return {
    isSetupComplete: store ? store.get('isSetupComplete') : false,
    defaultScanner: store ? store.get('defaultScanner') : null,
    isBusy: scanInProgress,
    engineExists: fs.existsSync(getNaps2Info().cmd),
    os: process.platform,
  };
});

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('wizard:hide-window', () => {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.hide();
  }
});

let installInProgress = false;

ipcMain.handle('setup:install-engine', async (event) => {
  if (installInProgress) {
    return { success: false, error: 'Install already running', phase: 'guard' };
  }
  installInProgress = true;
  try {
    return await installNaps2Engine(event.sender);
  } finally {
    installInProgress = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SETUP WINDOW
//
//  Shown only on first run (no defaultScanner saved) or when the user
//  clicks "Change Scanner…" in the system tray. Loads a self-contained
//  HTML file — no Next.js renderer required.
// ═══════════════════════════════════════════════════════════════════════════

function createSetupWindow() {
  // If the window already exists, just bring it to front
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 420,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    show: false,
    title: 'dims-scanner — Scanner Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.loadFile(path.join(__dirname, 'scanner-setup.html'));

  setupWindow.once('ready-to-show', () => {
    setupWindow.show();
  });

  // Close-to-tray: hide the window instead of quitting the app
  setupWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      setupWindow.hide();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SYSTEM TRAY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * (Re)build the tray context menu. Called on startup and whenever the
 * default scanner is changed, so the display label stays current.
 */
function buildTrayMenu() {
  const scannerName = store ? store.get('defaultScanner') : null;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: scannerName ? `Scanner: ${scannerName}` : 'No scanner configured',
      enabled: false, // Display-only label
    },
    {
      label: 'Change Scanner…',
      click: () => {
        const wasExisting = setupWindow && !setupWindow.isDestroyed();
        createSetupWindow();

        // Tell the renderer to reset its UI state to the discovery step
        // (or the locked step if a scan is currently in progress).
        if (wasExisting) {
          // Existing (hidden) window — renderer is already loaded, send immediately
          setupWindow.webContents.send('wizard:force-discovery');
        } else {
          // Fresh window — wait for the renderer to finish loading
          setupWindow.webContents.once('did-finish-load', () => {
            setupWindow.webContents.send('wizard:force-discovery');
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Completely',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  const iconPath = isDev
    ? path.join(__dirname, 'tray-icon.png')
    : path.join(process.resourcesPath, 'app', 'electron', 'tray-icon.png');

  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('dims-scanner — Silent Hardware Agent');
  buildTrayMenu();

  // Left-click on tray icon opens the setup/change-scanner window
  tray.on('click', () => {
    createSetupWindow();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOCAL HTTP SERVER (Port 3002) — Async Polling Architecture
//
//  The Next.js web app communicates with this agent exclusively over HTTP:
//
//    POST /trigger-scan   → kicks off an async scan job
//    GET  /status?scanId= → polls for result (base64 PDF when ready)
//    GET  /health         → verifies the agent is running & configured
//
//  All responses include permissive CORS headers so the browser-based
//  frontend can call localhost:3002 without being blocked.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set wide-open CORS headers on every HTTP response.
 * Required because the Next.js frontend runs on a different port.
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  // Chrome Private Network Access (PNA) — required when a public HTTPS origin
  // (e.g. a dev tunnel) makes a request to a private/loopback address.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
}

/** Convenience: write a JSON response with proper Content-Type. */
function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function startTriggerServer() {
  triggerServer = http.createServer((req, res) => {
    // ── CORS headers on every response ────────────────────────────────
    setCorsHeaders(res);

    // ── OPTIONS preflight — return 204 No Content immediately ─────────
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse the URL for pathname + query params
    const url = new URL(req.url, `http://127.0.0.1:${TRIGGER_PORT}`);

    // ── GET /health ──────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/health') {
      const scanner = store ? store.get('defaultScanner') : null;
      jsonResponse(res, 200, {
        status: 'ok',
        app: 'dims-scanner',
        configured: !!scanner,
        scanner: scanner || null,
      });
      return;
    }

    // ── POST /trigger-scan ───────────────────────────────────────────
    //
    // Accepts: { "scanId": "<unique-id>" }
    // Returns: 200 immediately. The scan runs asynchronously.
    //          Poll GET /status?scanId=... for the result.
    // ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/trigger-scan') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { scanId } = JSON.parse(body);

          // ── Validation ──────────────────────────────────────────
          if (!scanId) {
            jsonResponse(res, 400, { error: 'Missing scanId' });
            return;
          }

          const defaultScanner = store ? store.get('defaultScanner') : null;
          if (!defaultScanner) {
            jsonResponse(res, 500, { error: 'No scanner configured. Open the agent from the system tray to set one up.' });
            return;
          }

          // Prevent duplicate scan IDs
          if (scanJobs[scanId]) {
            jsonResponse(res, 409, { error: 'Scan ID already exists. Use a unique scanId for each request.' });
            return;
          }

          // Prevent concurrent hardware access — scanners are serial devices
          if (scanInProgress) {
            scanJobs[scanId] = {
              status: 'error',
              data: null,
              error: 'Another scan is already in progress. Please wait and try again.',
              createdAt: Date.now(),
            };
            jsonResponse(res, 200, { success: true, scanId });
            return;
          }

          // ── Register the job and respond immediately ────────────
          const abortController = new AbortController();
          scanJobs[scanId] = {
            status: 'scanning',
            data: null,
            error: null,
            createdAt: Date.now(),
            abortController,
          };
          jsonResponse(res, 200, { success: true, scanId });

          // ── Async scan pipeline (fires after HTTP response) ─────
          (async () => {
            scanInProgress = true;
            try {
              // Step 1: Pre-flight check — is the scanner online?
              const isOnline = await preFlightCheck(scanId);
              if (!isOnline) return; // Job already marked as 'error'

              // Step 2: Execute the physical scan → PDF
              console.log(`[Scan] Starting scan for job ${scanId} on "${defaultScanner}"`);
              const pdfDataUrl = await scanDocumentPdf(defaultScanner, abortController.signal);

              // Step 3: Store the result for polling
              scanJobs[scanId].status = 'ready';
              scanJobs[scanId].data = pdfDataUrl;
              console.log(`[Scan] Job ${scanId} complete — PDF ready for pickup`);

            } catch (err) {
              // Gracefully handle AbortError — user cancelled the scan
              if (err.name === 'AbortError' || abortController.signal.aborted) {
                console.log(`[Scan] Job ${scanId} was cancelled by user.`);
                // Status may already be set by /cancel-scan; ensure consistency
                if (scanJobs[scanId]) {
                  scanJobs[scanId].status = 'error';
                  scanJobs[scanId].error = 'Scan cancelled by user.';
                }
              } else {
                console.error(`[Scan] Job ${scanId} failed:`, err.message);
                if (scanJobs[scanId]) {
                  scanJobs[scanId].status = 'error';
                  scanJobs[scanId].error = err.message || 'Scan failed unexpectedly. Check scanner connection.';
                }
              }
            } finally {
              scanInProgress = false;
              // Clear the AbortController reference to allow GC
              if (scanJobs[scanId]) {
                scanJobs[scanId].abortController = null;
              }
            }
          })();

        } catch {
          jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
        }
      });
      return;
    }

    // ── POST /cancel-scan ────────────────────────────────────────────
    //
    // Accepts: { "scanId": "<unique-id>" }
    // Aborts an in-progress scan job and frees the hardware.
    // ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/cancel-scan') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { scanId } = JSON.parse(body);

          if (!scanId) {
            jsonResponse(res, 400, { error: 'Missing scanId' });
            return;
          }

          const job = scanJobs[scanId];
          if (!job) {
            jsonResponse(res, 404, { error: 'Unknown scanId' });
            return;
          }

          if (job.status !== 'scanning') {
            jsonResponse(res, 200, { success: false, message: `Job is not scanning (current status: ${job.status})` });
            return;
          }

          // Abort the child process via the stored AbortController
          if (job.abortController) {
            job.abortController.abort();
          }

          // Immediately update job state
          job.status = 'error';
          job.error = 'Scan cancelled by user.';
          job.abortController = null;

          // Free the hardware for the next scan attempt
          scanInProgress = false;

          console.log(`[Scan] Job ${scanId} cancelled via /cancel-scan`);
          jsonResponse(res, 200, { success: true, message: 'Scan aborted' });

        } catch {
          jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
        }
      });
      return;
    }

    // ── GET /status?scanId=... ───────────────────────────────────────
    //
    // Returns the current state of a scan job:
    //   { status: 'scanning' }
    //   { status: 'ready', data: 'data:application/pdf;base64,...' }
    //   { status: 'error', error: '...' }
    // ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/status') {
      const scanId = url.searchParams.get('scanId');

      if (!scanId) {
        jsonResponse(res, 400, { error: 'Missing scanId query parameter' });
        return;
      }

      const job = scanJobs[scanId];
      if (!job) {
        jsonResponse(res, 404, { error: 'Unknown scanId' });
        return;
      }

      if (job.status === 'scanning') {
        jsonResponse(res, 200, { status: 'scanning' });
      } else if (job.status === 'ready') {
        jsonResponse(res, 200, { status: 'ready', data: job.data });
      } else if (job.status === 'error') {
        jsonResponse(res, 200, { status: 'error', error: job.error });
      }
      return;
    }

    // ── 404 catch-all ────────────────────────────────────────────────
    jsonResponse(res, 404, { error: 'Not found' });
  });

  triggerServer.listen(TRIGGER_PORT, '127.0.0.1', () => {
    console.log(`[Server] HTTP trigger server listening on http://127.0.0.1:${TRIGGER_PORT}`);
  });

  // ── Port conflict detection ──────────────────────────────────────────
  triggerServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] FATAL: Port ${TRIGGER_PORT} is already in use.`);
      dialog.showErrorBox(
        'Port Conflict',
        `Port ${TRIGGER_PORT} is already in use by another application.\n\n` +
        `dims-scanner cannot start its local server. Please close the conflicting ` +
        `application and restart dims-scanner.`
      );
    } else {
      console.error(`[Server] Error: ${err.message}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATER
// ═══════════════════════════════════════════════════════════════════════════

function setupAutoUpdater() {
  if (!autoUpdater || isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // Fail silently — log only, never crash, never show UI if offline
    console.log('[AutoUpdater] Error:', err.message);
  });

  autoUpdater.on('update-downloaded', (info) => {
    // No parent window — the dialog appears as a standalone system dialog
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded. Restart to apply?`,
        buttons: ['Restart Now', 'Later'],
      })
      .then((result) => {
        if (result.response === 0) {
          isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.log('[AutoUpdater] Check failed (offline?):', err.message);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  JOB CLEANUP — prevent memory leaks from abandoned scan jobs
//
//  Runs every 10 minutes and purges jobs older than 30 minutes.
//  This handles the case where the web app triggers a scan but never
//  polls for the result (e.g., user closes the browser tab).
// ═══════════════════════════════════════════════════════════════════════════

setInterval(() => {
  const cutoff = Date.now() - JOB_EXPIRY_MS;
  for (const id of Object.keys(scanJobs)) {
    if (scanJobs[id].createdAt < cutoff) {
      console.log(`[Cleanup] Expiring stale scan job: ${id}`);
      delete scanJobs[id];
    }
  }
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
//  APP LIFECYCLE
//
//  Boot sequence (strictly sequential — store MUST be ready before
//  the server or tray try to read from it):
//
//    1. Dynamically import electron-store (ESM-only package in CJS context)
//    2. Create the system tray (reads store for scanner label)
//    3. Start the HTTP trigger server (reads store for defaultScanner)
//    4. Setup auto-updater
//    5. Conditionally show setup window (if no scanner configured)
// ═══════════════════════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  // ── Step 1: Initialize persistent storage ───────────────────────────
  // electron-store v11 is ESM-only. Dynamic import() works in CJS under
  // Node 22 / Electron 35.
  try {
    const { default: Store } = await import('electron-store');
    store = new Store({
      defaults: {
        defaultScanner: null,
        isSetupComplete: false,
        naps2PortablePath: null,
      },
    });
    console.log('[Store] Initialized. Default scanner:', store.get('defaultScanner') || '(none)');
  } catch (err) {
    console.error('[Store] Failed to initialize electron-store:', err.message);
    dialog.showErrorBox(
      'Initialization Error',
      `Failed to initialize settings storage:\n\n${err.message}\n\nThe application will now quit.`
    );
    app.quit();
    return;
  }

  // ── Step 2: System tray (always — the agent's only persistent UI) ───
  createTray();

  // ── Step 3: HTTP trigger server (always — the web app needs it) ─────
  startTriggerServer();

  // ── Step 4: Auto-updater ────────────────────────────────────────────
  setupAutoUpdater();

  // ── Step 5: Setup Gatekeeper (Self-Healing) ──────────────────────────
  const isSetupComplete = store.get('isSetupComplete');
  const engineExists = fs.existsSync(getNaps2Info().cmd);

  if (!isSetupComplete || !engineExists) {
    const reason = !isSetupComplete
      ? 'Setup not complete'
      : 'Engine missing (self-healing triggered)';
    console.log(`[Agent] ${reason} — showing setup wizard`);
    createSetupWindow();
  } else {
    console.log('[Agent] Setup complete — running silently in system tray');
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (triggerServer) {
    triggerServer.close();
  }
});

// Silent agent — never quit just because windows are closed.
// The app lives in the system tray and the HTTP server.
app.on('window-all-closed', () => {
  // Intentionally empty — do not call app.quit()
});