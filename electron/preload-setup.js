const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal preload bridge for the scanner setup window.
 * Exposes only the two IPC calls the setup UI needs — nothing more.
 */
contextBridge.exposeInMainWorld('setupAPI', {
  /**
   * Check whether the NAPS2 scan engine is installed on this system.
   * @returns {Promise<{ exists: boolean, os: string }>}
   */
  checkEngine: () => ipcRenderer.invoke('setup:check-engine'),

  /**
   * Discover available scanner devices via NAPS2.
   * May take up to 30 seconds for Wi-Fi scanners.
   * @returns {Promise<string[]>} Array of device name strings
   */
  getScanners: () => ipcRenderer.invoke('scanner:list'),

  /**
   * Save the selected scanner as the default and hide the setup window.
   * @param {string} deviceName — The device string to persist
   * @returns {Promise<{ success: boolean }>}
   */
  saveScanner: (deviceName) => ipcRenderer.invoke('scanner:save-default', deviceName),

  /**
   * Fetch current app state (setup status, default scanner, busy flag).
   * @returns {Promise<{ isSetupComplete: boolean, defaultScanner: string|null, isBusy: boolean }>}
   */
  getState: () => ipcRenderer.invoke('setup:get-state'),

  /**
   * Trigger NAPS2 download + install. Resolves when finished or failed.
   * Listen via onInstallProgress for live status updates.
   * @returns {Promise<{ success: boolean, version?: string, cmd?: string, error?: string, phase?: string, manualUrl?: string }>}
   */
  installEngine: () => ipcRenderer.invoke('setup:install-engine'),

  /**
   * Subscribe to install progress events from the main process.
   * Returns an unsubscribe function — call it to detach the listener.
   * @param {(payload: { phase: string, percent: number, message: string, version?: string, bytesReceived?: number, bytesTotal?: number }) => void} callback
   * @returns {() => void}
   */
  onInstallProgress: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('setup:install-engine:progress', listener);
    return () => ipcRenderer.removeListener('setup:install-engine:progress', listener);
  },

  /**
   * Quit the entire app (used by the "No" button on the dependency gatekeeper).
   */
  quitApp: () => ipcRenderer.invoke('app:quit'),

  /**
   * Hide the setup window via IPC. Used by the Success screen "Close Window"
   * button — does NOT alter any renderer step state, just hides the native window.
   */
  hideWindow: () => ipcRenderer.invoke('wizard:hide-window'),

  /**
   * Subscribe to the "force discovery" event sent by the tray's Change Scanner
   * menu item. The renderer should reset its UI to the discovery step (or the
   * locked step if a scan is currently in progress).
   */
  onForceDiscovery: (callback) => ipcRenderer.on('wizard:force-discovery', callback),
});
