// Preload script for DeepSeek Host Page
// Bridges real Node.js FS & Shell capabilities to window.__DU_DESKTOP__
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__DU_DESKTOP__', {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  selectDirectory: () => ipcRenderer.invoke('desktop:select-directory'),
  
  // Real FS API
  fs: {
    readFile: (filePath) => ipcRenderer.invoke('desktop:fs:read-file', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('desktop:fs:write-file', filePath, content),
    listDir: (dirPath) => ipcRenderer.invoke('desktop:fs:list-dir', dirPath),
    stat: (targetPath) => ipcRenderer.invoke('desktop:fs:stat', targetPath),
    mkdir: (dirPath) => ipcRenderer.invoke('desktop:fs:mkdir', dirPath),
    unlink: (targetPath) => ipcRenderer.invoke('desktop:fs:unlink', targetPath)
  },

  // Real Terminal Execution API
  terminal: {
    exec: (command, cwd) => ipcRenderer.invoke('desktop:terminal:exec', { command, cwd })
  }
});

// Suppress automation / unsafe browser flags inside the webview DOM
window.addEventListener('DOMContentLoaded', () => {
  // Prevent website detecting navigator.webdriver
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
  } catch (e) {}

  // Inject seamless custom drag region for modern titleBarOverlay
  const dragBar = document.createElement('div');
  dragBar.id = 'du-desktop-drag-region';
  dragBar.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 140px;
    height: 35px;
    z-index: 999999;
    -webkit-app-region: drag;
    pointer-events: none;
  `;
  document.documentElement.appendChild(dragBar);
});
