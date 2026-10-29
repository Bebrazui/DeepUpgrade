// Preload script for DeepSeek Host Page
// Bridges real Node.js FS & Shell capabilities to window.__DU_DESKTOP__
const { contextBridge, ipcRenderer } = require('electron');

// Async fetch config into global scope
ipcRenderer.invoke('desktop:get-config').then(cfg => {
  window.__DU_DESKTOP_CONFIG__ = cfg;
});

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

// Comprehensive Chromium Anti-Detect & Chrome Emulation
(function applyFullStealth() {
  // 1. Remove navigator.webdriver completely
  try {
    const proto = Object.getPrototypeOf(navigator);
    delete proto.webdriver;
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });
  } catch (e) {}

  // 2. Realistic plugins and languages
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ru-RU', 'ru', 'en-US', 'en'],
      configurable: true
    });
  } catch (e) {}

  // 3. Emulate chrome object with app, runtime, csi, loadTimes
  try {
    window.chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
      },
      runtime: {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }
      },
      csi: function() {},
      loadTimes: function() {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.1,
          startLoadTime: Date.now() / 1000 - 0.2,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true
        };
      }
    };
  } catch (e) {}

  // 4. WebGL Vendor / Renderer spoofing (typical Intel/NVIDIA gaming/workstation GPU)
  try {
    const getParameterProto = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
        return 'Google Inc. (NVIDIA)';
      }
      if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
        return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      }
      return getParameterProto.apply(this, arguments);
    };

    if (window.WebGL2RenderingContext) {
      const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Google Inc. (NVIDIA)';
        if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameterProto2.apply(this, arguments);
      };
    }
  } catch (e) {}

  // 5. Clean up any cdc_ automation variables
  try {
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  } catch (e) {}
})();

// Inject seamless custom drag region for modern titleBarOverlay
window.addEventListener('DOMContentLoaded', () => {
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
