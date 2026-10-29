// DeepUpgrade Desktop - Main Process
// Ultra-compact, fast, with native OS bridge and stealth browser configuration.
const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { detectAvailableShells } = require('./shellDetector');

// Ensure a single persistent instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Full stealth flags for Chromium to bypass Google OAuth & Cloudflare bot detection
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('enable-features', 'NetworkService,NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-site-isolation-trials');

// Key fix for Google Accounts: prevent Google from identifying embedded framework / webview
app.commandLine.appendSwitch('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
app.commandLine.appendSwitch('lang', 'ru-RU');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-certificate-errors');

// Config file path in user data directory
const CONFIG_PATH = path.join(app.getPath('userData'), 'deepupgrade_config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return null;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save config:', e);
    return false;
  }
}

let mainWindow = null;
let setupWindow = null;

// Stealth Anti-Detect configuration:
// Replaces typical Electron fingerprints with authentic Google Chrome on Windows 10/11
const AUTHENTIC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function configureStealthSession(ses) {
  // 1. Spoof User-Agent globally
  ses.setUserAgent(AUTHENTIC_USER_AGENT);

  // 2. Full authentic Google Chrome HTTP Headers & Client Hints
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || '';
    
    // Inject full realistic Chrome 130 Headers
    details.requestHeaders['User-Agent'] = AUTHENTIC_USER_AGENT;
    details.requestHeaders['sec-ch-ua'] = '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';
    details.requestHeaders['sec-ch-ua-mobile'] = '?0';
    details.requestHeaders['sec-ch-ua-platform'] = '"Windows"';
    details.requestHeaders['sec-ch-ua-platform-version'] = '"15.0.0"';
    details.requestHeaders['sec-ch-ua-full-version-list'] = '"Chromium";v="130.0.6723.70", "Google Chrome";v="130.0.6723.70", "Not?A_Brand";v="99.0.0.0"';
    details.requestHeaders['Accept-Language'] = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

    // Remove any automation or leaking headers
    delete details.requestHeaders['X-Requested-With'];
    delete details.requestHeaders['Sec-Fetch-User'];

    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  // 3. Prevent CSP or site isolation from blocking auth
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ cancel: false, responseHeaders: details.responseHeaders });
  });
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 380,
    height: 480,
    resizable: false,
    maximizable: false,
    frame: false,
    transparent: false,
    title: 'DeepUpgrade Desktop Setup',
    backgroundColor: '#101114',
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

function createMainWindow() {
  const cfg = loadConfig() || {};
  const ses = session.defaultSession;
  configureStealthSession(ses);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek - DeepUpgrade Desktop',
    backgroundColor: '#131416',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#131416',
      symbolColor: '#8b909a',
      height: 35
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nativeWindowOpen: true,
      webSecurity: true,
      sandbox: false
    }
  });

  // Handle Google OAuth popups seamlessly: give popup full Chrome identity
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 500,
        height: 650,
        autoHideMenuBar: true,
        title: 'Sign in with Google',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          nativeWindowOpen: true,
          sandbox: true
        }
      }
    };
  });

  mainWindow.setMenuBarVisibility(false);

  // Inject content.js and injected.css automatically when pages load
  const extDir = path.resolve(__dirname, '..', 'extension');
  const contentJsPath = path.join(extDir, 'content.js');
  const injectedCssPath = path.join(extDir, 'ui', 'injected.css');

  mainWindow.webContents.on('did-finish-load', async () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (currentUrl.includes('chat.deepseek.com')) {
      // Inject CSS
      try {
        if (fs.existsSync(injectedCssPath)) {
          const css = fs.readFileSync(injectedCssPath, 'utf8');
          await mainWindow.webContents.insertCSS(css);
        }
      } catch (err) {
        console.error('Failed to inject CSS:', err);
      }

      // Inject Content Script
      try {
        if (fs.existsSync(contentJsPath)) {
          const js = fs.readFileSync(contentJsPath, 'utf8');
          await mainWindow.webContents.executeJavaScript(js);
        }
      } catch (err) {
        console.error('Failed to inject content.js:', err);
      }
    }
  });

  // Navigate to DeepSeek
  mainWindow.loadURL('https://chat.deepseek.com/', {
    userAgent: AUTHENTIC_USER_AGENT
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// -------------------------------------------------------------
// IPC Handlers: Setup & System Integration
// -------------------------------------------------------------
ipcMain.handle('setup:get-shells', async () => {
  return detectAvailableShells();
});

ipcMain.handle('setup:save-config', async (event, cfg) => {
  return saveConfig(cfg);
});

ipcMain.handle('setup:close-window', async () => {
  if (setupWindow) {
    setupWindow.close();
  }
});

ipcMain.handle('setup:launch-app', async () => {
  if (setupWindow) {
    setupWindow.close();
  }
  createMainWindow();
});

// -------------------------------------------------------------
// IPC Handlers: Real Host FS & Terminal
// -------------------------------------------------------------
ipcMain.handle('desktop:get-config', async () => {
  return loadConfig();
});

ipcMain.handle('desktop:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Выберите папку проекта для работы DeepUpgrade'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('desktop:fs:read-file', async (event, filePath) => {
  try {
    const data = await fs.promises.readFile(filePath, 'utf8');
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:fs:write-file', async (event, filePath, content) => {
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:fs:list-dir', async (event, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const list = entries.map(e => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile()
    }));
    return { ok: true, entries: list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:fs:stat', async (event, targetPath) => {
  try {
    const st = await fs.promises.stat(targetPath);
    return {
      ok: true,
      size: st.size,
      mtime: st.mtimeMs,
      isDirectory: st.isDirectory()
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:fs:mkdir', async (event, dirPath) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:fs:unlink', async (event, targetPath) => {
  try {
    await fs.promises.unlink(targetPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Real OS Terminal Execution
ipcMain.handle('desktop:terminal:exec', async (event, { command, cwd }) => {
  const cfg = loadConfig() || {};
  const shellObj = cfg.shell || {};
  const shellPath = shellObj.path || null;

  return new Promise((resolve) => {
    const options = {
      cwd: cwd || process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    };

    if (shellPath && fs.existsSync(shellPath)) {
      options.shell = shellPath;
    }

    exec(command, options, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err ? (err.code || 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (err ? err.message : '')
      });
    });
  });
});

// App Lifecycle
app.whenReady().then(() => {
  const cfg = loadConfig();
  if (cfg && cfg.completed) {
    createMainWindow();
  } else {
    createSetupWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const currentCfg = loadConfig();
      if (currentCfg && currentCfg.completed) createMainWindow();
      else createSetupWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
