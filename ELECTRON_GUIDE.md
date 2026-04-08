# Free Scan Desktop App - Complete Technical Guide

This document explains every layer of the pure Electron + Next.js desktop architecture, how each file connects to the others, and every command you need to run from zero to a distributable `.exe` / `.dmg` / `.AppImage`.

**Python has been fully removed from the runtime.** The old Python/FastAPI backend is archived in `_legacy_python_reference/` for reference only. Electron's Node.js main process now drives scanner hardware directly via `child_process.execFile`.

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Project File Map](#2-project-file-map)
3. [Prerequisites](#3-prerequisites)
4. [Architecture Deep Dive](#4-architecture-deep-dive)
   - [Layer 1: Electron Main Process (Scanner Bridge)](#layer-1-electron-main-process-scanner-bridge)
   - [Layer 2: Preload Bridge (Secure IPC)](#layer-2-preload-bridge-secure-ipc)
   - [Layer 3: Next.js Frontend (Renderer)](#layer-3-nextjs-frontend-renderer)
5. [Deep-Link & Trigger Server Integration](#5-deep-link--trigger-server-integration)
6. [The Complete Startup Sequence](#6-the-complete-startup-sequence)
7. [The Complete Shutdown Sequence](#7-the-complete-shutdown-sequence)
8. [Running in Development Mode](#8-running-in-development-mode)
9. [Building for Production](#9-building-for-production)
10. [How electron-builder Packages Everything](#10-how-electron-builder-packages-everything)
11. [Auto-Updates](#11-auto-updates)
12. [Platform-Specific Notes](#12-platform-specific-notes)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. The Big Picture

```
BEFORE (Python era - removed):
  User runs "python agent_ui.py"  ->  FastAPI server on port 8000
  User opens browser              ->  http://localhost:3000
  Frontend fetches http://localhost:8000/scan
  Problems: zombie processes, port conflicts, manual startup

AFTER (Pure Electron - current):
  User double-clicks "Free Scan"
    -> Electron starts (single process, no local UI server)
    -> Trigger server starts on port 3002 (for web app integration)
    -> Window loads static Next.js UI
    -> User clicks "Scan Page"
    -> React calls window.electronAPI.scanDocument() via IPC
    -> Electron main process runs NAPS2 CLI via child_process
    -> Scanned image returned to React as base64 data-URL
    -> User closes window -> app hides to system tray
    -> User clicks "Quit" in tray -> clean exit
    -> ZERO background UI servers, ZERO Python
```

There are **two persistent processes** running:

```
[Electron Main Process]      (Node.js - scanner bridge + trigger server + app lifecycle)
    |
    +-- [Renderer Process]   (Chromium - React UI from static Next.js export)
```

The main process also runs an HTTP trigger server on **port 3002** that accepts scan requests from external web applications (see [Section 5](#5-deep-link--trigger-server-integration)).

When a scan is triggered, the main process spawns a **short-lived** child process (`naps2` or `scanimage` CLI), waits for it to finish, reads the output file, and returns the data. No persistent scanner process.

---

## 2. Project File Map

```
free-scan/
|
+-- electron/                         # --- ELECTRON LAYER ---
|   +-- main.js                       # The brain. Scanner bridge + IPC + tray + trigger server + auto-updates.
|   +-- preload.js                    # Secure IPC bridge (contextBridge). 6 exposed methods.
|   +-- tray-icon.png                 # 16x16 system tray icon.
|
+-- app/                              # --- NEXT.JS FRONTEND ---
|   +-- components/
|   |   +-- DocumentScanner.tsx       # Scanner UI. Calls window.electronAPI (no HTTP).
|   +-- layout.tsx                    # Root HTML layout (Geist fonts, metadata).
|   +-- page.tsx                      # Home page (renders DocumentScanner).
|   +-- globals.css                   # Tailwind CSS v4 theme variables.
|
+-- next.config.ts                    # Static export: output: 'export', images.unoptimized: true.
+-- package.json                      # Dependencies, scripts, electron-builder config.
+-- tsconfig.json                     # TypeScript configuration (ES2017, strict).
|
+-- _legacy_python_reference/         # --- ARCHIVED (never packaged) ---
|   +-- main.py                       # Old FastAPI backend (reference only).
|   +-- agent_ui.py                   # Old agent dashboard.
|   +-- electron_entry.py             # Old uvicorn wrapper.
|   +-- FreeScanAgent.spec            # Old PyInstaller spec.
|   +-- FreeScanElectron.spec         # Old PyInstaller spec.
|
+-- dist/                             # [LEGACY] Old PyInstaller binary output. Not used.
+-- out/                              # [GENERATED] Static HTML from `npm run build`.
+-- release/                          # [GENERATED] .exe/.dmg/.AppImage from electron-builder.
```

---

## 3. Prerequisites

| Tool | Version | Why | Install |
|------|---------|-----|---------|
| **Node.js** | >= 18 | Runs Electron + Next.js | https://nodejs.org |
| **npm / yarn** | npm >= 9 or yarn 1.22+ | Package manager | Comes with Node.js |
| **NAPS2** | >= 7 | Scanner hardware CLI | https://www.naps2.com |

**Python is NOT required.** It has been completely removed from the runtime.

Verify:

```bash
node --version     # v18+
npm --version      # 9+
naps2 --version    # or check NAPS2 is installed
```

### Install Node.js dependencies (first time only)

```bash
cd /home/propelius-tech/Desktop/free-scan
npm install
```

---

## 4. Architecture Deep Dive

### Layer 1: Electron Main Process (Scanner Bridge)

**File:** `electron/main.js`

This single file replaces the entire Python FastAPI backend. It handles four concerns:

**A) Scanner Hardware Functions** (replaces `main.py`):

| Function | What it does | Equivalent old Python |
|----------|-------------|----------------------|
| `getNaps2Info()` | Returns OS-specific NAPS2 command and driver flag | `_get_driver_flag()` + `get_naps2_command()` |
| `isSaneTestDevice(name)` | Detects SANE virtual test devices | `_is_sane_test_device()` |
| `listScanners()` | Runs `naps2 --listdevices`, parses output (30s timeout) | `GET /scanners` endpoint |
| `scanDocument(deviceName)` | Runs NAPS2/scanimage, returns base64 data-URL (120s timeout) | `GET /scan` endpoint |

Platform-specific NAPS2 commands:

```
Windows:  naps2.console.exe --driver wia --listdevices
macOS:    /Applications/NAPS2.app/Contents/MacOS/naps2 console --driver apple --listdevices
Linux:    naps2 --driver sane --listdevices
```

**B) IPC Handlers** (replaces HTTP endpoints):

```javascript
ipcMain.handle('scanner:list', async () => {
  return listScanners();    // Returns string[]
});

ipcMain.handle('scanner:scan', async (_event, deviceName) => {
  return scanDocument(deviceName);    // Returns "data:image/png;base64,..."
});

ipcMain.handle('scanner:upload', async (_event, { pdfBytes, scanId, returnUrl }) => {
  // POSTs PDF as FormData to returnUrl/api/documents/upload
  // Returns { success: boolean, path?: string }
});

ipcMain.handle('scanner:get-pending-deep-link', async () => {
  // Returns queued deep-link trigger payload (pull-based)
  // Returns { scanId, returnUrl } or null
});
```

**C) Trigger Server** (web app integration):

The main process starts an HTTP server on **port 3002** via `startTriggerServer()`. External web applications can POST to `http://localhost:3002/trigger-scan` with a JSON body `{ scanId, returnUrl }` to trigger the scan workflow. This brings the Electron window to the foreground and delivers the scan request to the renderer.

**D) Enterprise UX:**

- Single instance lock (prevents duplicate app launches)
- System tray with "Show App" / "Quit Completely" menu
- Close-to-tray behavior (X button hides, doesn't quit)
- Auto-updater (silent check, graceful offline failure)
- Deep-link protocol support (`freescan://` URL scheme)

---

### Layer 2: Preload Bridge (Secure IPC)

**File:** `electron/preload.js`

This file is the **security boundary** between Node.js (full OS access) and the web page (sandboxed). It uses Electron's `contextBridge` to expose exactly six methods:

```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  // Scanner operations
  getScanners:  () => ipcRenderer.invoke('scanner:list'),
  scanDocument: (deviceName) => ipcRenderer.invoke('scanner:scan', deviceName),

  // PDF upload (for deep-link flow)
  uploadPdf: ({ pdfBytes, scanId, returnUrl }) =>
    ipcRenderer.invoke('scanner:upload', { pdfBytes, scanId, returnUrl }),

  // Deep-link listeners
  onScanStart: (callback) =>
    ipcRenderer.on('scan:start', (_event, payload) => callback(payload)),
  removeScanStartListener: () =>
    ipcRenderer.removeAllListeners('scan:start'),

  // Pull-based deep-link retrieval
  getPendingDeepLink: () => ipcRenderer.invoke('scanner:get-pending-deep-link'),
});
```

The renderer cannot access Node.js, the filesystem, or `child_process`. It can ONLY call these six methods.

**Data flow for a scan:**

```
[React UI]                    [Preload]                    [Main Process]
    |                             |                             |
    |  window.electronAPI         |                             |
    |  .scanDocument("HP Scan")   |                             |
    |------------------------------>                             |
    |                             |  ipcRenderer.invoke         |
    |                             |  ('scanner:scan', "HP Scan")|
    |                             |----------------------------->
    |                             |                             |
    |                             |              execFile('naps2', ['-o', tmp])
    |                             |              ... scanner hardware runs ...
    |                             |              fs.readFileSync(tmp) -> base64
    |                             |                             |
    |                             |     "data:image/png;base64,iVBOR..."
    |                             |<-----------------------------|
    |   "data:image/png;base64,   |                             |
    |    iVBOR..."                |                             |
    |<-----------------------------|                             |
    |                             |                             |
    |  setState -> render <img>   |                             |
```

---

### Layer 3: Next.js Frontend (Renderer)

**File:** `app/components/DocumentScanner.tsx`

The component uses a typed `ElectronAPI` interface:

```typescript
interface ElectronAPI {
  getScanners: () => Promise<string[]>;
  scanDocument: (deviceName: string) => Promise<string>;
  uploadPdf: (payload: { pdfBytes: number[]; scanId: string; returnUrl: string }) =>
    Promise<{ success: boolean; path?: string }>;
  onScanStart: (callback: (payload: { scanId: string; returnUrl: string }) => void) => void;
  removeScanStartListener: () => void;
  getPendingDeepLink: () => Promise<{ scanId: string; returnUrl: string } | null>;
}
```

**State management:**

| State | Type | Purpose |
|-------|------|---------|
| `pages` | `ScannedPage[]` | Array of scanned images (`{ id, dataUrl }`) |
| `activeIndex` | `number` | Index of currently previewed page |
| `scanning` | `boolean` | Loading state during scan |
| `compiling` | `boolean` | Loading state during PDF compilation |
| `error` | `string\|null` | Error message for the UI banner |
| `scanners` | `string[]` | Available scanner devices from backend |
| `selectedScanner` | `string` | Currently selected device |
| `loadingScanners` | `boolean` | Loading state during scanner enumeration |
| `deepLinkScan` | `object\|null` | Deep-link trigger payload (`{ scanId, returnUrl }`) |
| `uploadSuccess` | `boolean` | Shows green success banner after upload |

**Key changes from the Python era:**

| Before (HTTP) | After (IPC) |
|---------------|-------------|
| `fetch("http://localhost:8000/scanners")` | `window.electronAPI.getScanners()` |
| `fetch("http://localhost:8000/scan?device_name=...")` -> blob -> dataUrl | `window.electronAPI.scanDocument(name)` -> dataUrl directly |
| `blobToDataUrl()` helper needed | Not needed - main process returns base64 |
| Port management, CORS, error parsing | None of this exists anymore |
| No upload capability | `window.electronAPI.uploadPdf()` sends PDF to web app |

The `dataUrlToUint8Array()` helper remains for PDF compilation via pdf-lib.

If `window.electronAPI` is missing (opened in a plain browser), the component shows an error: "This app must be run inside the Electron desktop shell."

---

## 5. Deep-Link & Trigger Server Integration

Free Scan can be triggered from an external web application to scan documents and upload the resulting PDF back to the web app's server.

### How it works

```
[Web App]                    [Trigger Server :3002]        [Electron Main]         [React UI]
    |                             |                             |                      |
    |  POST /trigger-scan         |                             |                      |
    |  { scanId, returnUrl }      |                             |                      |
    |---------------------------->|                             |                      |
    |                             |  deliverScanTrigger()       |                      |
    |                             |----------------------------->                      |
    |                             |                             |  IPC 'scan:start'    |
    |                             |                             |--------------------->|
    |                             |                             |  (window focused)    |
    |        200 OK               |                             |                      |
    |<----------------------------|                             |                      |
    |                             |                             |                      |
    |                                           User scans pages in desktop app...     |
    |                                                                                  |
    |                             |                             |  scanner:upload IPC   |
    |                             |                             |<---------------------|
    |                             |                             |                      |
    |  POST returnUrl/api/documents/upload                      |                      |
    |  (FormData with PDF)                                      |                      |
    |<-----------------------------------------------------------                      |
    |                             |                             |                      |
    |                             |                             |  { success: true }   |
    |                             |                             |--------------------->|
    |                             |                             |  (success banner)    |
```

### Trigger methods

1. **HTTP Trigger Server (port 3002)** - Primary method. A web app POSTs `{ scanId, returnUrl }` to `http://localhost:3002/trigger-scan`.
2. **OS Deep Links** - The app registers the `freescan://` protocol. A URL like `freescan://scan?scanId=abc&returnUrl=https://example.com` opens the app and triggers a scan.
3. **Pull-based polling** - The renderer polls `getPendingDeepLink()` every 1 second as a fallback if the push-based IPC event is missed (e.g., if the renderer wasn't ready when the trigger arrived).

### Deep-link mode in the UI

When a deep-link scan is active (`deepLinkScan` state is set):
- A **blue info banner** appears: "Scan triggered from web application"
- The "Upload Document" button text changes to **"Upload to Web App"**
- On compile, the PDF is sent to `returnUrl/api/documents/upload` via the main process (avoids CORS) instead of being downloaded locally
- A **green success banner** appears after successful upload

---

## 6. The Complete Startup Sequence

```
1.  User double-clicks "Free Scan"
2.  Electron binary launches -> electron/main.js runs
3.  Single instance check:
    - Another instance exists? -> Focus its window, EXIT
    - No other instance? -> Continue
4.  app.whenReady() fires (Chromium initialized)
5.  createWindow():
    - BrowserWindow created (1200x800, min 800x600, hidden)
    - preload.js loaded (exposes window.electronAPI)
    - Production: loads out/index.html from disk
    - Dev: loads http://localhost:3001
6.  ready-to-show -> window becomes visible
7.  createTray() -> system tray icon appears
8.  startTriggerServer() -> HTTP server on port 3002 starts
9.  setupAutoUpdater() -> silent GitHub release check
10. React app mounts:
    - DocumentScanner useEffect fires
    - Calls window.electronAPI.getScanners()
    - IPC -> main process -> execFile('naps2 --listdevices') -> parse
    - Scanner names returned -> dropdown populated
    - Registers onScanStart listener for deep-link triggers
    - Starts polling getPendingDeepLink() every 1 second
11. App is ready. User can scan documents or receive triggers from web apps.
```

**No UI server to wait for. No health check polling. Window appears immediately.**

---

## 7. The Complete Shutdown Sequence

```
SCENARIO A: User clicks "Quit Completely" in tray
  1. isQuitting = true
  2. triggerServer.close() (HTTP server on port 3002 shut down)
  3. app.quit()
  4. Window closes normally (isQuitting bypasses hide-to-tray)
  5. App exits.

SCENARIO B: User clicks the window X button
  1. 'close' event fires
  2. isQuitting is false -> e.preventDefault() -> window hides
  3. App lives in system tray, trigger server still running on port 3002
  4. Click tray icon -> window reappears

SCENARIO C: macOS Cmd+Q
  1. 'before-quit' fires -> isQuitting = true
  2. Window close is allowed (isQuitting is true)
  3. App exits
```

No zombie processes possible - there is no persistent scanner process to leak. The trigger server is a lightweight Node.js HTTP server that shuts down cleanly with the app.

---

## 8. Running in Development Mode

### Step 1: Install dependencies (first time)

```bash
cd /home/propelius-tech/Desktop/free-scan
npm install
```

### Step 2: Start the app

```bash
npm run electron:dev
```

This does two things simultaneously (via `concurrently`):
1. `next dev --port 3001` - starts the Next.js dev server on **port 3001** (hot-reload)
2. `wait-on http://localhost:3001 && RENDERER_PORT=3001 electron .` - waits for Next.js, then launches Electron with the renderer port set

The Electron window appears, loading from `http://localhost:3001`. Any changes to React code appear instantly.

**Note:** In dev mode, scanner hardware calls still work (the main process uses `child_process.execFile` regardless of dev/prod). The trigger server also runs on port 3002. You need NAPS2 installed to list real scanners.

### Step 3: Stop

Press `Ctrl+C` in the terminal.

---

## 9. Building for Production

Only **two steps**. No Python. No PyInstaller.

### Step 1: Build the Next.js static export

```bash
npm run build
```

Runs `next build` with `output: 'export'` and `images.unoptimized: true`. Produces `out/` containing:
- `index.html` - your complete app
- `_next/static/` - JS bundles, CSS, self-hosted fonts

Verify: `ls out/index.html`

### Step 2: Package the Electron app

```bash
npx electron-builder --publish never
```

Bundles Electron runtime + `electron/` + `out/` into a platform installer.

Output in `release/`:
| Platform | File |
|----------|------|
| Linux | `Free Scan-1.0.0.AppImage` |
| Windows | `Free Scan Setup 1.0.0.exe` |
| macOS | `Free Scan-1.0.0.dmg` |

### Both steps combined

```bash
npm run electron:build
```

This single command runs `next build && electron-builder --publish never`.

---

## 10. How electron-builder Packages Everything

```
Final packaged app structure:
.
+-- Free Scan (executable - Electron + Chromium + Node.js runtime)
+-- resources/
    +-- app/
        +-- electron/
        |   +-- main.js          <- Scanner bridge + IPC + trigger server + tray
        |   +-- preload.js       <- Secure API bridge (6 methods)
        |   +-- tray-icon.png    <- Tray icon
        +-- out/
            +-- index.html       <- Static React frontend
            +-- _next/           <- JS, CSS, fonts
```

**Excluded from the package** (via `files` config + `.gitignore`):
- `_legacy_python_reference/` - archived Python code
- `dist/` - old PyInstaller binary output
- `venv/` - Python virtual environment
- `__pycache__/` - Python bytecode
- `app/` - Next.js source (only the built `out/` is included)
- `node_modules/` - managed by electron-builder automatically

**Registered protocol:** The app registers `freescan://` as a custom URL scheme for deep-link integration.

**No `extraResources` needed** - no Python binary to bundle.

---

## 11. Auto-Updates

Uses `electron-updater` to check GitHub Releases.

### Setup

1. Edit `package.json`, replace `YOUR_GITHUB_USERNAME`:
```json
"publish": {
  "provider": "github",
  "owner": "your-actual-username",
  "repo": "free-scan"
}
```

2. Set a GitHub token and build:
```bash
export GH_TOKEN=ghp_your_token_here
npm version patch
npx electron-builder --publish always
```

### Offline behavior

The auto-updater is configured to **fail silently**:
- If the user is offline, it logs `[AutoUpdater] Check failed (offline?)` and moves on
- No crash, no dialog, no error shown to the user
- The app works normally without network access

---

## 12. Platform-Specific Notes

### Windows
- NAPS2 uses WIA driver. Most scanners work out of the box.
- Without code-signing, SmartScreen shows "Unknown publisher" warning.
- Command: `naps2.console.exe`
- NSIS installer supports custom install directory.

### macOS
- NAPS2 must be installed at `/Applications/NAPS2.app/`
- Unsigned apps trigger Gatekeeper warning. Fix for dev: `xattr -cr "/Applications/Free Scan.app"`
- Command: `/Applications/NAPS2.app/Contents/MacOS/naps2 console`
- DMG supports both x64 and arm64 (Apple Silicon).

### Linux
- NAPS2 uses SANE driver. Install: `sudo apt install sane-utils naps2`
- User must be in the `scanner` group: `sudo usermod -aG scanner $USER`
- Command: `naps2`
- AppImage needs execute permission: `chmod +x "Free Scan-1.0.0.AppImage"`

---

## 13. Troubleshooting

### "This app must be run inside the Electron desktop shell"
You opened the app in a regular browser. The IPC bridge (`window.electronAPI`) only exists inside Electron. Use `npm run electron:dev`.

### Scanners not showing up
- Is NAPS2 installed? Test: `naps2 --driver sane --listdevices` (Linux)
- Is your user in the `scanner` group? (Linux: `groups $USER`)
- Discovery timeout is 30 seconds - wireless scanners may take time to appear.

### Window is blank/white
- **Dev:** Is Next.js running? Check `http://localhost:3001` in a browser.
- **Prod:** Does `out/index.html` exist? Run `npm run build`.

### electron-builder errors
- `"icon not found"` - Create `public/icon.ico` / `.icns` / `.png`, or remove the `icon` fields from `package.json`'s build config to use default icons.

### Scan fails with "Scanner produced an empty or missing file"
- NAPS2 ran but didn't produce output. Check if the scanner is powered on and connected.
- Run manually: `naps2 console -o /tmp/test.png --noprofile` to debug.

### Port 3002 already in use
- Another instance of Free Scan may be running. The single-instance lock should prevent this, but check: `lsof -i :3002` (Linux/macOS) or `netstat -ano | findstr 3002` (Windows).
- Kill the process or quit the existing instance from the system tray.

### Deep-link trigger not reaching the app
- Ensure the trigger server is running (check console logs for `[TriggerServer] Listening on port 3002`).
- Verify the POST body is valid JSON: `{ "scanId": "...", "returnUrl": "https://..." }`.
- The window should automatically come to the foreground when a trigger is received.

---

## Quick Reference

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Run in dev mode | `npm run electron:dev` |
| Build static frontend | `npm run build` |
| Package desktop app | `npx electron-builder --publish never` |
| Build + package (one shot) | `npm run electron:build` |
| Bump version | `npm version patch` |
| Publish update | `GH_TOKEN=xxx npx electron-builder --publish always` |
| Test trigger server | `curl -X POST http://localhost:3002/trigger-scan -H "Content-Type: application/json" -d '{"scanId":"test","returnUrl":"http://localhost:3000"}'` |
