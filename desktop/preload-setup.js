// Preload script for Setup Window
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAvailableShells: () => ipcRenderer.invoke('setup:get-shells'),
  saveConfig: (cfg) => ipcRenderer.invoke('setup:save-config', cfg),
  launchApp: () => ipcRenderer.invoke('setup:launch-app'),
  closeWindow: () => ipcRenderer.invoke('setup:close-window')
});
