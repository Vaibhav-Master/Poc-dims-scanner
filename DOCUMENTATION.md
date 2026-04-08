# Free Scan — Project Documentation

> A silent desktop agent that bridges scanner hardware to web applications. It lives in your system tray, exposes a tiny HTTP API on `127.0.0.1:3002`, and turns physical scans into base64-encoded PDFs that any browser can pick up.

---

## Quick Answers (Read This First)

If you only have two minutes, this section answers the three questions everyone asks.

### 1. Why does this app need Chromium?

Free Scan is built on **Electron**, and Electron *bundles its own copy of Chromium* as the rendering engine. There are actually **two distinct Chromium roles** in this system, and confusing them is the #1 source of architectural bugs:

- **Chromium inside Electron** — Even though Free Scan looks "headless" (it runs silently in the system tray), the Electron process still needs Chromium to render the **Setup Wizard**. The wizard is just an HTML file ([electron/scanner-setup.html](electron/scanner-setup.html)) loaded into a Chromium `BrowserWindow`. Without Chromium, Electron literally cannot draw a window — not even the wizard.

- **Chromium in the user's everyday browser** (Chrome, Edge, Brave, etc.) — The *external* web frontend that triggers scans runs in the user's normal browser, on a totally different origin from the agent. Chrome enforces **CORS** and **Private Network Access (PNA)** rules on requests from a public HTTPS origin (e.g. an HTTPS dev tunnel) to a private/loopback address (`127.0.0.1:3002`). This is why `setCorsHeaders()` at [electron/main.js:430-438](electron/main.js#L430-L438) sets `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network: true`, and the OPTIONS preflight handler at [electron/main.js:452-456](electron/main.js#L452-L456) returns `204 No Content` with those headers attached.

In short: **Electron uses Chromium to render the wizard. The user's separate browser uses Chromium (or whatever they have) to call the agent's HTTP API.**

### 2. Where do the requests come from?

**Not from the bundled `app/` directory in this repo.** That Next.js code is **legacy/dormant** — `package.json` `build.files` ([package.json:50-59](package.json#L50-L59)) explicitly excludes `app/**/*`, `.next/**/*`, and `out/**/*` from the packaged installer. It is *not shipped* with the agent.

The actual consumer is a **separate Next.js web application** running on its own origin:

- **In development**, that frontend is served via an HTTPS dev tunnel (e.g. `https://something.devtunnels.ms`).
- **In production**, it's the company's hosted web app on a real domain.

That external frontend calls `fetch('http://127.0.0.1:3002/trigger-scan', …)` directly from the user's browser. Because the call crosses origins (HTTPS public → HTTP loopback) and crosses network zones (public → private), the browser fires an `OPTIONS` preflight first. Only if the agent responds with the right CORS + PNA headers does the actual `POST` proceed.

```
[ User's Browser @ https://*.devtunnels.ms ]
              │
              │  fetch('http://127.0.0.1:3002/trigger-scan')
              │  (CORS + PNA preflight first)
              ▼
[ Electron Agent @ 127.0.0.1:3002 ]   ← THIS REPO
              │
              │  child_process.execFile()
              ▼
[ NAPS2 / scanimage CLI ]
              │
              │  USB / Wi-Fi
              ▼
[ Physical Scanner Hardware ]
```

### 3. How does the scan flow actually work?

It's an **async polling architecture**, not a long-lived request. The agent never holds an HTTP connection open while the scanner is busy. Step by step:

1. The browser sends `OPTIONS /trigger-scan` (preflight). The agent responds `204` with CORS + PNA headers. ([electron/main.js:452-456](electron/main.js#L452-L456))
2. The browser sends `POST /trigger-scan` with `{ "scanId": "<unique-id>" }`. ([electron/main.js:479](electron/main.js#L479))
3. The agent validates the request, registers a job in an in-memory `scanJobs` map, and **immediately responds `200 { success: true, scanId }`**. The actual scan is fired off *after* the response, inside an async IIFE at [electron/main.js:528](electron/main.js#L528).
4. Pre-flight check (`preFlightCheck` at [electron/main.js:145](electron/main.js#L145)) re-runs `naps2 --listdevices` to confirm the saved scanner is physically online. If not, the job is marked `error` and a native OS dialog is shown.
5. `scanDocumentPdf` ([electron/main.js:192](electron/main.js#L192)) spawns NAPS2 (or `scanimage` for `test:` virtual devices) with a 5-minute timeout. NAPS2 writes a PDF directly to a temp file.
6. The PDF bytes are read, base64-encoded into a `data:application/pdf;base64,...` URL, and stored on the job. The temp file is deleted in `finally`.
7. **Meanwhile**, the browser is polling `GET /status?scanId=<id>` ([electron/main.js:634](electron/main.js#L634)) every second or two. Each poll returns one of:
   - `{ status: "scanning" }` — keep polling
   - `{ status: "ready", data: "data:application/pdf;base64,…" }` — done
   - `{ status: "error", error: "<message>" }` — failed
8. When the browser sees `ready`, it grabs the data URL and either uploads it to its own backend or offers it to the user as a download.
9. Stale jobs (no one ever polled for the result) are purged after 30 minutes by an interval at [electron/main.js:727](electron/main.js#L727).
10. The user can cancel an in-progress scan with `POST /cancel-scan` ([electron/main.js:581](electron/main.js#L581)), which calls `abortController.abort()` on the live child process.

That's the whole lifecycle.

---

## Architecture Overview

There is **one persistent process**: the Electron main process (Node.js). Inside it, several subsystems cooperate:

```
┌──────────────────────────────────────────────────────────────┐
│              Electron Main Process (Node.js)                 │
│                                                              │
│  ┌────────────────────┐    ┌─────────────────────────────┐   │
│  │  HTTP Server       │    │  System Tray                │   │
│  │  127.0.0.1:3002    │    │  - "Scanner: <name>"        │   │
│  │  (the public API)  │    │  - "Change Scanner…"        │   │
│  │                    │    │  - "Quit Completely"        │   │
│  └─────────┬──────────┘    └──────────────┬──────────────┘   │
│            │                              │                  │
│            ▼                              ▼                  │
│  ┌────────────────────┐    ┌─────────────────────────────┐   │
│  │  scanJobs map      │    │  Setup Wizard (on demand)   │   │
│  │  (in-memory async  │    │  Chromium BrowserWindow     │   │
│  │   job tracking)    │    │  loadFile(scanner-setup.html│   │
│  └─────────┬──────────┘    └──────────────┬──────────────┘   │
│            │                              │                  │
│            ▼                              ▼ (IPC via         │
│  ┌────────────────────┐    ┌─────────────────────────────┐   │
│  │  NAPS2 Bridge      │    │  preload-setup.js           │   │
│  │  child_process     │    │  exposes window.setupAPI    │   │
│  │  (.execFile)       │    │  - checkEngine              │   │
│  └─────────┬──────────┘    │  - getScanners              │   │
│            │               │  - saveScanner              │   │
│            │               │  - getState                 │   │
│            │               └─────────────────────────────┘   │
│            │                                                 │
│            │     ┌─────────────────────────────┐             │
│            │     │  electron-store (on disk)   │             │
│            │     │  - defaultScanner           │             │
│            │     │  - isSetupComplete          │             │
│            │     └─────────────────────────────┘             │
│            │                                                 │
│            │     ┌─────────────────────────────┐             │
│            │     │  electron-updater           │             │
│            │     │  (packaged builds only)     │             │
│            │     └─────────────────────────────┘             │
└────────────┼─────────────────────────────────────────────────┘
             │
             ▼
   ┌───────────────────┐
   │  NAPS2 / scanimage│
   │  CLI (short-lived)│
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │  Scanner Hardware │
   │  (USB / Wi-Fi)    │
   └───────────────────┘
```

Key invariants:

- **No bundled UI window.** The current build never opens a Next.js renderer. The only `BrowserWindow` ever created is the Setup Wizard, and only on first run or via the tray's "Change Scanner…" item.
- **One scan at a time.** Scanners are serial devices. A single boolean `scanInProgress` ([electron/main.js:59](electron/main.js#L59)) gates concurrent access.
- **Single instance.** A second launch focuses the existing wizard window instead of starting a duplicate agent ([electron/main.js:69-81](electron/main.js#L69-L81)).
- **Closing the window does not quit the app.** The `window-all-closed` handler is intentionally empty ([electron/main.js:806-808](electron/main.js#L806-L808)).

---

## Tech Stack

| Layer    | Technology                | Version  | Purpose                                            |
|----------|---------------------------|----------|----------------------------------------------------|
| Desktop  | Electron                  | ^35.0.0  | Bundles Chromium + Node.js, owns the process       |
| Storage  | electron-store            | ^11.0.2  | Persists `defaultScanner`, `isSetupComplete`       |
| Updates  | electron-updater          | ^6.6.2   | Auto-update from GitHub Releases (packaged only)   |
| PDF      | pdf-lib                   | ^1.17.1  | Wraps PNG output from `test:` devices into PDF     |
| Scanner  | NAPS2                     | v7+      | Cross-platform scanner CLI (WIA / Apple / SANE)    |
| Scanner  | scanimage (SANE)          | -        | Linux fallback for virtual `test:0` devices        |
| Frontend | Next.js / React           | 16.2.1 / 19.2.4 | **Legacy/dormant** — see "Project Structure" |

> Python is **not** required. The old FastAPI agent has been removed; archived code lives in `_legacy_python_reference/` for reference only.

---

## HTTP API Reference

The HTTP server lives in `startTriggerServer()` at [electron/main.js:446](electron/main.js#L446). Every response — including errors — gets the CORS + PNA headers from `setCorsHeaders` ([electron/main.js:430-438](electron/main.js#L430-L438)):

```
Access-Control-Allow-Origin:          *
Access-Control-Allow-Methods:         GET, POST, OPTIONS
Access-Control-Allow-Headers:         Content-Type, Authorization, X-Requested-With
Access-Control-Allow-Private-Network: true
Access-Control-Max-Age:               86400
```

### `GET /health`

Liveness + configuration check. Used by frontends to verify the agent is running before triggering a scan.

```bash
curl -i http://127.0.0.1:3002/health
```

**Response 200:**
```json
{
  "status": "ok",
  "app": "free-scan",
  "configured": true,
  "scanner": "Brother MFC-L2750DW"
}
```

`configured: false` means no default scanner is set — the user needs to open the wizard from the tray.

Implemented at [electron/main.js:462](electron/main.js#L462).

---

### `POST /trigger-scan`

Starts an asynchronous scan job. Returns `200` immediately; the scan runs in the background and the result must be polled via `GET /status`.

**Request:**
```bash
curl -X POST http://127.0.0.1:3002/trigger-scan \
  -H "Content-Type: application/json" \
  -d '{"scanId":"job-2026-04-07-001"}'
```

**Body:** `{ "scanId": "<unique-string>" }`

**Responses:**

| Status | Body                                                   | When                                            |
|--------|--------------------------------------------------------|-------------------------------------------------|
| 200    | `{ "success": true, "scanId": "..." }`                 | Job accepted (or queued as already-failed if scanner is busy) |
| 400    | `{ "error": "Missing scanId" }`                        | `scanId` missing or body is invalid JSON        |
| 409    | `{ "error": "Scan ID already exists. ..." }`           | Duplicate `scanId`                              |
| 500    | `{ "error": "No scanner configured. ..." }`            | User has not completed first-run setup          |

If a scan is already in progress, the new job is registered immediately as `error` (`"Another scan is already in progress."`) instead of being rejected — so the polling client gets a normal `error` status from `/status` rather than a different shape.

Implemented at [electron/main.js:479-572](electron/main.js#L479-L572).

---

### `GET /status?scanId=<id>`

Poll the state of a job. Call this every 1-2 seconds after triggering.

```bash
curl "http://127.0.0.1:3002/status?scanId=job-2026-04-07-001"
```

**Responses (all status 200):**
```json
{ "status": "scanning" }
```
```json
{ "status": "ready", "data": "data:application/pdf;base64,JVBERi0..." }
```
```json
{ "status": "error", "error": "Scanner offline or disconnected. Please check the device and try again." }
```

| Status | Body                              | When                              |
|--------|-----------------------------------|-----------------------------------|
| 400    | `{ "error": "Missing scanId..." }`| Query param missing               |
| 404    | `{ "error": "Unknown scanId" }`   | No job with that ID (or expired)  |

Implemented at [electron/main.js:634-657](electron/main.js#L634-L657).

---

### `POST /cancel-scan`

Aborts an in-progress scan. The underlying NAPS2 / scanimage child process is killed via the job's `AbortController`, the hardware lock is released, and the job state moves to `error`.

```bash
curl -X POST http://127.0.0.1:3002/cancel-scan \
  -H "Content-Type: application/json" \
  -d '{"scanId":"job-2026-04-07-001"}'
```

**Responses:**

| Status | Body                                                            |
|--------|-----------------------------------------------------------------|
| 200    | `{ "success": true, "message": "Scan aborted" }`                |
| 200    | `{ "success": false, "message": "Job is not scanning ..." }`    |
| 400    | `{ "error": "Missing scanId" }` / `{ "error": "Invalid JSON" }` |
| 404    | `{ "error": "Unknown scanId" }`                                 |

Implemented at [electron/main.js:581-625](electron/main.js#L581-L625).

---

### `OPTIONS *`

Any `OPTIONS` request — typically a browser CORS / PNA preflight — returns `204 No Content` immediately, with the full set of CORS + PNA headers attached. The actual route is never matched. Implemented at [electron/main.js:452-456](electron/main.js#L452-L456).

---

### Minimal browser example (trigger + poll)

```js
async function scanDocument() {
  const scanId = crypto.randomUUID();

  // 1. Trigger
  const trig = await fetch('http://127.0.0.1:3002/trigger-scan', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ scanId }),
  }).then(r => r.json());

  if (!trig.success) throw new Error(trig.error || 'Trigger failed');

  // 2. Poll until ready or error
  while (true) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await fetch(
      `http://127.0.0.1:3002/status?scanId=${encodeURIComponent(scanId)}`
    ).then(r => r.json());

    if (s.status === 'ready')   return s.data;          // base64 data URL
    if (s.status === 'error')   throw new Error(s.error);
    // status === 'scanning' → keep waiting
  }
}
```

---

## Setup Wizard (First Run + Self-Healing)

The Setup Wizard is the only window the agent ever shows. It's an Electron `BrowserWindow` that loads [electron/scanner-setup.html](electron/scanner-setup.html) and uses [electron/preload-setup.js](electron/preload-setup.js) to expose `window.setupAPI` (4 methods: `checkEngine`, `getScanners`, `saveScanner`, `getState`).

### When it opens

The wizard is shown automatically on app launch when either condition is true ([electron/main.js:783-794](electron/main.js#L783-L794)):

```js
const isSetupComplete = store.get('isSetupComplete');
const engineExists    = fs.existsSync(getNaps2Info().cmd);

if (!isSetupComplete || !engineExists) {
  createSetupWindow();
}
```

It can also be opened on demand from the tray menu ("Change Scanner…").

### Wizard steps

1. **Welcome** → user clicks "Begin Setup".
2. **Engine Check** → calls `checkEngine` (`setup:check-engine` IPC at [electron/main.js:299](electron/main.js#L299)) to see if the NAPS2 binary exists at the expected OS path.
3. **Engine Intervention** (only if missing) → shows OS-specific install instructions (NAPS2 download link, `winget install NAPS2.NAPS2`, `brew install --cask naps2`, or the Linux APT script). User installs NAPS2, clicks "Check Again".
4. **Discovery** → calls `getScanners` (`scanner:list` IPC at [electron/main.js:277](electron/main.js#L277)) which runs `naps2 console --driver <driver> --listdevices` with a 30-second timeout.
5. **Save & Continue** → calls `saveScanner` (`scanner:save-default` IPC at [electron/main.js:281](electron/main.js#L281)) which persists the choice to `electron-store`, rebuilds the tray menu, and hides the wizard.
6. **Locked** (alternative path) → if a scan is already in progress when the user opens the wizard, a "Hardware in Use" screen is shown instead so they can't change the scanner mid-scan.

### Self-healing

Every launch re-checks `fs.existsSync(getNaps2Info().cmd)`. If the user uninstalls NAPS2 between sessions, the wizard re-appears the next time the app starts — even if `isSetupComplete` was previously true.

---

## NAPS2 Bridge (Hardware Layer)

All scanner interaction goes through three functions in [electron/main.js](electron/main.js):

### `getNaps2Info()` ([line 91](electron/main.js#L91))

Returns the right CLI command, base args, and driver flag for the current OS:

| OS       | Command                                             | Args        | Driver  |
|----------|-----------------------------------------------------|-------------|---------|
| Windows  | `C:\Program Files\NAPS2\naps2.console.exe` (with x86 fallback) | `[]`        | `wia`   |
| macOS    | `/Applications/NAPS2.app/Contents/MacOS/naps2`      | `[console]` | `apple` |
| Linux    | `/usr/bin/naps2` (or `naps2` on PATH)               | `[console]` | `sane`  |

### `listScanners()` ([line 111](electron/main.js#L111))

Runs `naps2 console --driver <driver> --listdevices` (30-second timeout to allow Wi-Fi scanners to respond), filters out NAPS2 banner noise (Copyright, Possible values, etc.), and returns a deduplicated list of device names. If NAPS2 is not installed or the call fails entirely, falls back to `['test:0']` so the wizard never shows an empty list.

### `scanDocumentPdf(deviceName, abortSignal)` ([line 192](electron/main.js#L192))

Two paths:

- **Test devices** (device name starts with `test:` or contains `frontend-tester`): bypasses NAPS2 entirely. Calls `scanimage -d <dev> --format=png -o <tmp>.png`, then wraps the PNG in a single-page PDF using `pdf-lib`. NAPS2 cannot drive virtual SANE devices, so this path exists for CI / headless dev.
- **Real hardware**: NAPS2 with `-o <tmp>.pdf --noprofile --driver <driver> --device "<name>"`. The `.pdf` extension tells NAPS2 to emit PDF directly. **No `--source` flag is set**, so NAPS2 auto-picks ADF or flatbed based on hardware capability.

5-minute timeout (`SCAN_TIMEOUT_MS`) accommodates large ADF stacks. The output PDF is read into memory, base64-encoded, and the temp file is deleted in `finally` — scan data never lingers on disk.

### `getCleanEnv()` ([line 37](electron/main.js#L37))

When running as a Linux **AppImage**, Electron injects its bundled libraries into `LD_LIBRARY_PATH`. This breaks any external CLI (`naps2`, `scanimage`) that links against system libraries. `getCleanEnv()` strips `LD_LIBRARY_PATH` from the environment passed to spawned children so they inherit the host's clean linker path. Every `execFileAsync` call uses `env: getCleanEnv()`. **Don't remove this** — it's a real bug fix that's easy to undo by accident.

---

## State & Persistence

### Persistent (on disk)

`electron-store` v11 is ESM-only, so it's loaded via dynamic `import()` in a CJS context at [electron/main.js:755](electron/main.js#L755):

```js
const { default: Store } = await import('electron-store');
store = new Store({
  defaults: { defaultScanner: null, isSetupComplete: false },
});
```

Stored keys:
- `defaultScanner` — the device name selected in the wizard
- `isSetupComplete` — set true after the first successful save

### In-memory only

- **`scanJobs`** ([electron/main.js:55](electron/main.js#L55)) — keyed by `scanId`. Each entry has `{ status, data, error, createdAt, abortController }`. Cleared on app quit. Pruned every 10 minutes (entries older than 30 minutes) by the interval at [electron/main.js:727](electron/main.js#L727).
- **`scanInProgress`** ([electron/main.js:59](electron/main.js#L59)) — single boolean. The hardware concurrency guard.

---

## Process Lifecycle

### Boot order ([electron/main.js:750-795](electron/main.js#L750-L795))

1. **Single-instance lock.** If another instance already holds it, `app.quit()` immediately. The original instance's `second-instance` handler focuses the wizard window if it exists.
2. `app.whenReady()` resolves.
3. **Init `electron-store`** via dynamic import (failure shows a fatal error dialog and quits).
4. **Create system tray.** Reads `defaultScanner` to label the menu.
5. **Start HTTP server** on port 3002. A port conflict triggers a native error dialog and the app keeps running but without the API.
6. **Setup auto-updater** (no-op in development; only runs when `app.isPackaged`).
7. **Setup gatekeeper** — open the wizard if `!isSetupComplete || !engineExists`; otherwise log "running silently" and stay headless.

### Shutdown ([electron/main.js:797-801](electron/main.js#L797-L801))

`before-quit` sets `isQuitting = true` and closes the HTTP server cleanly.

### Window-all-closed ([electron/main.js:806-808](electron/main.js#L806-L808))

**Intentionally empty.** Closing the wizard window does NOT quit the app — it stays alive in the tray. The only ways to quit are: tray "Quit Completely" menu item, OS-level kill, or `app.quit()` from inside the auto-updater after a downloaded update.

---

## Project Structure

```
free-scan/
├── electron/                          ← THE SHIPPED AGENT
│   ├── main.js                        ← The brain (HTTP server, NAPS2 bridge, tray, lifecycle)
│   ├── preload-setup.js               ← contextBridge for the setup wizard only
│   ├── scanner-setup.html             ← Setup wizard UI (vanilla HTML + CSS + JS)
│   └── tray-icon.png                  ← System tray icon (16×16)
│
├── package.json                       ← Dependencies + electron-builder config
├── DOCUMENTATION.md                   ← This file
├── ELECTRON_GUIDE.md                  ← Older deep-dive (some sections out of date)
├── CLAUDE.md / AGENTS.md              ← AI assistant instructions
│
├── app/                               ← LEGACY / DORMANT — not packaged
│   ├── components/DocumentScanner.tsx ← References window.electronAPI that has no preload backing it
│   ├── layout.tsx, page.tsx, globals.css
│
├── _legacy_python_reference/          ← Archived old FastAPI agent — never run
├── dist/                              ← Leftover from PyInstaller days — never built
├── out/                               ← [Generated] Static Next.js export — not packaged
├── release/                           ← [Generated] electron-builder output (.exe / .dmg / .AppImage)
└── public/                            ← Static assets (icons)
```

The packaged installer **only contains** what `package.json` `build.files` allows ([package.json:50-59](package.json#L50-L59)):

```json
"files": [
  "electron/**/*",
  "package.json",
  "!_legacy_python_reference",
  "!venv",
  "!__pycache__",
  "!app/**/*",
  "!.next/**/*",
  "!out/**/*"
]
```

Note the explicit exclusions of `app/**/*`, `.next/**/*`, and `out/**/*`. The bundled Next.js project is not part of the shipped agent.

---

## Setup & Running

### Prerequisites

- **Node.js** 18+ and a package manager (`npm` or `yarn`).
- **NAPS2** installed and on PATH (the wizard prompts you with install instructions if it's missing).
- A connected scanner — or use the virtual `test:0` device on Linux for headless testing.

Python is **not** required.

### Install

```bash
npm install
```

### Run the agent locally

```bash
npm run electron:dev
```

This is just `electron .` — it loads `electron/main.js` directly. There is no Next.js dev server orchestration, because the agent doesn't need one. On first run:

1. The Setup Wizard appears.
2. If NAPS2 is missing, the wizard shows OS-specific install instructions.
3. Pick a scanner → click "Save & Continue" → wizard hides.
4. The agent goes silent and lives in the tray.
5. Test from a terminal:
   ```bash
   curl -i http://127.0.0.1:3002/health
   ```

### Build a distributable installer

```bash
npm run build:win    # Windows  → release/*.exe (NSIS)
npm run build:mac    # macOS    → release/*.dmg (x64 + arm64)
npm run build:linux  # Linux    → release/*.AppImage (x64)
```

Auto-updates publish to GitHub Releases (`Vaibhav-Master/YC_directory`).

### npm scripts in `package.json`

| Script              | What it does                                                |
|---------------------|-------------------------------------------------------------|
| `npm run dev`       | `next dev` — only useful if you're working on the legacy `app/` UI |
| `npm run build`     | `next build` — produces the dormant Next.js export          |
| `npm run start`     | `next start` — Next.js prod server (not used with the agent)|
| `npm run lint`      | ESLint                                                      |
| `npm run electron:dev` | `electron .` — launches the agent                        |
| `npm run build:win` / `build:mac` / `build:linux` | `electron-builder --<platform>` |

> ⚠️  There is no `electron:build` script. Use `build:win` / `build:mac` / `build:linux` for the platform you want.

---

## Cross-Platform Notes

| OS       | Driver  | NAPS2 Binary                                              | Install                                |
|----------|---------|-----------------------------------------------------------|----------------------------------------|
| Windows  | `wia`   | `C:\Program Files\NAPS2\naps2.console.exe` (x86 fallback) | NAPS2 installer or `winget install NAPS2.NAPS2` |
| macOS    | `apple` | `/Applications/NAPS2.app/Contents/MacOS/naps2`            | `.app` bundle or `brew install --cask naps2`    |
| Linux    | `sane`  | `/usr/bin/naps2` (or on PATH)                             | Official NAPS2 APT repo (commands shown in wizard) |

The exact Linux APT install commands are embedded in the wizard at [electron/scanner-setup.html](electron/scanner-setup.html) (`getInstallInstructions`).

### SANE virtual test devices

For device names starting with `test:` or containing `frontend-tester`, the bridge bypasses NAPS2 and shells out to `scanimage` with a 30-second timeout. NAPS2 cannot drive virtual SANE devices, but `scanimage` can — this path is invaluable for headless CI testing.

### Linux AppImage `LD_LIBRARY_PATH` quirk

When running as an AppImage, Electron injects its own bundled libraries into `LD_LIBRARY_PATH`, which breaks every external CLI tool that links against system libraries (NAPS2, scanimage, etc.). `getCleanEnv()` strips that variable from the environment passed to children. See [electron/main.js:37-43](electron/main.js#L37-L43).

---

## Troubleshooting

### CORS error in the browser console

**Symptom:** "Access to fetch at 'http://127.0.0.1:3002/trigger-scan' has been blocked by CORS policy."

1. Confirm the agent is actually running:
   ```bash
   curl -i http://127.0.0.1:3002/health
   ```
2. Confirm the preflight headers come back:
   ```bash
   curl -i -X OPTIONS \
     -H "Origin: https://example.devtunnels.ms" \
     -H "Access-Control-Request-Method: POST" \
     http://127.0.0.1:3002/trigger-scan
   ```
   You should see `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, and `Access-Control-Allow-Private-Network: true`.

### Chrome "Private Network Access" preflight failed

**Symptom:** Chrome console shows "Request has been blocked because of Private Network Access checks."

This happens when an HTTPS public origin (your dev tunnel) calls an HTTP private/loopback address (`127.0.0.1:3002`). Two requirements:

1. The agent must respond with `Access-Control-Allow-Private-Network: true` on the preflight. This is set unconditionally at [electron/main.js:436](electron/main.js#L436).
2. The frontend must use **`127.0.0.1`**, not `localhost`. On some setups (e.g. with IPv6 quirks), `localhost` resolves to a different address than the agent is listening on, and Chrome's PNA classifier treats the two differently.

If the preflight headers look right but Chrome still blocks, check `chrome://flags/#private-network-access-send-preflights` and `#block-insecure-private-network-requests`.

### Port 3002 already in use

**Symptom:** Native error dialog: "Port 3002 is already in use by another application."

Some other process is bound to 3002. Find and kill it:

```bash
# Linux / macOS
lsof -i :3002

# Windows
netstat -ano | findstr :3002
```

Handled at [electron/main.js:667-679](electron/main.js#L667-L679).

### "Scanner offline or disconnected"

The pre-flight check (`preFlightCheck` at [electron/main.js:145](electron/main.js#L145)) re-runs `naps2 --listdevices` before every scan. If your saved scanner doesn't appear in the live list:

1. Power-cycle the scanner.
2. For USB: replug.
3. For Wi-Fi: confirm both devices are on the same network.
4. Open the wizard from the tray and re-pick the device — its name string may have changed.

### Setup wizard keeps reappearing on every launch

`engineExists` is failing — NAPS2 is not at the expected path. This is the **self-healing** behavior, not a bug. Reinstall NAPS2 using the install instructions in the wizard, then click "Check Again".

### Scan job stuck in "scanning" forever

1. Check the agent's terminal logs for `[Scan] Job <id> failed:` or AbortError messages.
2. Cancel it explicitly:
   ```bash
   curl -X POST http://127.0.0.1:3002/cancel-scan \
     -H "Content-Type: application/json" \
     -d '{"scanId":"<id>"}'
   ```
3. Worst case: jobs auto-expire after 30 minutes via the cleanup interval at [electron/main.js:727](electron/main.js#L727).

### Mixed-content blocking from an HTTPS dev tunnel

Modern Chromium *does* allow HTTP→loopback fetches from HTTPS top-level pages as long as PNA is satisfied — that's the whole point of the PNA spec. But some browsers, extensions, or corporate proxies still block mixed content unconditionally. If you see this with PNA already configured correctly, the workarounds (out of scope here) are:

- Run the agent behind a local HTTPS reverse proxy with a self-signed cert.
- Disable the offending browser extension.
- Use a non-tunnel dev URL (e.g. another loopback).

---

## What's NOT in This Build (Legacy / Dormant)

These exist in the repo but are not used by the current agent. Safe to ignore unless you're explicitly reviving them.

| Path                                  | Status                      | What it was                                          |
|---------------------------------------|-----------------------------|------------------------------------------------------|
| `_legacy_python_reference/`           | Archived                    | Old FastAPI/uvicorn agent and PyInstaller specs      |
| `app/components/DocumentScanner.tsx`  | Legacy / dormant            | References `window.electronAPI` with no preload backing it in this build |
| `app/layout.tsx` / `app/page.tsx`     | Legacy / dormant            | Renders the bundled UI (not loaded by the agent)     |
| `dist/`                               | Leftover                    | Old PyInstaller binary output                        |
| `out/`                                | Generated, not shipped      | `next build --output=export` artifact                |

The bundled `app/` Next.js project predates the silent-agent refactor. It's still buildable as a standalone web app, but the Electron main process never loads it. If you ever want a unified bundled-UI build, you'll need to add a real `electron/preload.js` to back the `electronAPI` interface that `DocumentScanner.tsx` expects.
