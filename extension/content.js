// <du-theme>
(function initDuThemeEngine() {
  'use strict';

  const THEMES = ['default', 'oled', 'cyberpunk', 'glass'];

  function normalizeTheme(value) {
    return THEMES.indexOf(value) === -1 ? 'default' : value;
  }

  function applyTheme(value) {
    const theme = normalizeTheme(value);
    const root = document.documentElement;
    if (root) {
      if (theme === 'default') root.removeAttribute('data-du-theme');
      else root.setAttribute('data-du-theme', theme);
    }
    try {
      localStorage.setItem('du_theme', theme);
    } catch (e) { /* private mode / disabled storage */ }
    return theme;
  }

  function storedTheme() {
    try {
      return normalizeTheme(localStorage.getItem('du_theme'));
    } catch (e) {
      return 'default';
    }
  }

  function init() {
    const current = storedTheme();
    if (current !== 'default') applyTheme(current);
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['du_theme'], (res) => {
        if (res && res.du_theme && res.du_theme !== 'default') applyTheme(res.du_theme);
      });
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes || !changes.du_theme) return;
          applyTheme(changes.du_theme.newValue);
        });
      }
    } catch (e) { /* storage API unavailable (Android WebView) */ }
  }

  window.__DU_THEME__ = {
    apply: applyTheme,
    normalize: normalizeTheme,
    current: () => (document.documentElement.getAttribute('data-du-theme') || 'default')
  };
  init();
})();
// </du-theme>

// <du-settings-bridge>
// One switch, three worlds.
//
// The popup lives in the chrome-extension:// origin and can only reach the page
// through chrome.storage + chrome.tabs.sendMessage, while the MAIN-world
// interceptor can only read the page's localStorage. So the flag is kept in
// BOTH places: chrome.storage.local is the durable source of truth, and the
// page's localStorage mirror is what the interceptor reads.
//
// Every writer goes through this bridge, so the popup switch and the in-page
// "Agent" button can never drift apart.
(function initDuSettingsBridge() {
  'use strict';

  const KEY = 'du_tools_enabled';
  const LEGACY_KEY = 'du_agent_enabled';

  function parseFlag(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    const v = String(raw).trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return fallback;
  }

  function readPageMirror() {
    try {
      const current = localStorage.getItem(KEY);
      if (current !== null) return parseFlag(current, null);
      // Migration: the in-page Agent button used to write du_agent_enabled.
      return parseFlag(localStorage.getItem(LEGACY_KEY), null);
    } catch (e) {
      return null;
    }
  }

  function writePageMirror(value) {
    try {
      localStorage.setItem(KEY, value ? 'true' : 'false');
    } catch (e) { /* private mode / disabled storage */ }
  }

  function readStored(cb) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        cb(readPageMirror());
        return;
      }
      chrome.storage.local.get([KEY], (res) => {
        const stored = res && res[KEY] !== undefined ? parseFlag(res[KEY], null) : null;
        cb(stored === null ? readPageMirror() : stored);
      });
    } catch (e) {
      cb(readPageMirror());
    }
  }

  function writeStored(value) {
    const next = !!value;
    writePageMirror(next);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [KEY]: next });
      }
    } catch (e) { /* storage unavailable (Android WebView) */ }
    return next;
  }

  const listeners = [];

  window.__DU_SETTINGS__ = {
    KEY,

    // Synchronous read of the page mirror (seeded from durable storage below).
    isEnabled() {
      const mirrored = readPageMirror();
      return mirrored === null ? true : mirrored;
    },

    setEnabled(value) {
      const next = writeStored(value);
      listeners.forEach(fn => { try { fn(next); } catch (e) {} });
      return next;
    },

    read(cb) {
      readStored((value) => {
        if (value !== null && value !== undefined) {
          writePageMirror(value);
          listeners.forEach(fn => { try { fn(value); } catch (e) {} });
        }
        cb(value);
      });
    },

    onChanged(cb) {
      listeners.push(cb);
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes || !changes[KEY]) return;
            const next = parseFlag(changes[KEY].newValue, true);
            writePageMirror(next);
            listeners.forEach(fn => { try { fn(next); } catch (e) {} });
          });
        }
      } catch (e) { /* storage API unavailable */ }
    }
  };

  // Seed the page mirror from the durable storage on load, so a popup switch
  // made in another tab is honoured even before the user sends a message.
  readStored((value) => {
    if (value !== null && value !== undefined) writePageMirror(value);
  });
})();
// </du-settings-bridge>

﻿// DeepUpgrade - OpenCode Authentic Core v7.0 (Skills Engine & Settings Integration)
console.log('%c[DeepUpgrade] OpenCode Engine v7.0 Active', 'background: #3b82f6; color: white; font-weight: bold; padding: 2px 6px;');

// <du-vfs-store>
// Durable VFS store (host page side).
//
// The tool sandbox (sandbox/runner.html) is a manifest sandbox page: Chromium
// gives it a unique origin, where OPFS and IndexedDB are unavailable. The host
// page does have storage access, so it owns the durable copy of the VFS and the
// sandbox mirrors every mutation here via postMessage.
//
// Layout: OPFS root -> `du-vfs/` -> the same tree the tools see, e.g.
// `/smoke/hard3.py` becomes `du-vfs/smoke/hard3.py`. Real nested files, so the
// tree can be inspected in DevTools -> Application -> Origin Private File System.
(function initDurableVfsStore() {
  'use strict';

  const ROOT_DIR = 'du-vfs';
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  function splitPath(path) {
    return String(path || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter((part) => part && part !== '.' && part !== '..');
  }

  // Bytes are stored raw in OPFS and their encoding is derived from the data
  // itself, so no sidecar metadata file can get out of sync with the tree:
  // valid UTF-8 is text, everything else is base64. Both directions are
  // lossless (UTF-8 decode -> encode returns the original bytes).
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(String(b64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function decodeUtf8OrNull(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  class DuVfsStore {
    constructor() {
      this.root = null;
      this.mode = 'memory';
      this.memory = new Map();
      this.ready = null;
      this.queue = Promise.resolve();
    }

    async init() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        try {
          if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
            const root = await navigator.storage.getDirectory();
            this.root = await root.getDirectoryHandle(ROOT_DIR, { create: true });
            this.mode = 'opfs';
            return this.mode;
          }
        } catch (err) {
          console.warn('[DeepUpgrade] OPFS is unavailable, VFS will live in memory only:', err && err.message);
        }
        this.mode = 'memory';
        return this.mode;
      })();
      return this.ready;
    }

    async loadAll() {
      await this.init();
      if (this.mode !== 'opfs') {
        return [...this.memory.values()].map((f) => ({ ...f }));
      }
      // Wait for pending writes. A file that is being replaced at this very
      // moment cannot be read (Chrome throws NotReadableError), and the file
      // would silently be missing from the snapshot the sandbox boots with -
      // which is exactly how a skill prompt stops being applied.
      await this.queue.catch(() => {});
      const out = [];
      const walk = async (dirHandle, prefix) => {
        for await (const [name, handle] of dirHandle.entries()) {
          const path = `${prefix}/${name}`;
          if (handle.kind === 'file') {
            try {
              const bytes = await this.readBytesWithRetry(handle);
              const text = decodeUtf8OrNull(bytes);
              out.push({
                path,
                // Binary files travel as base64 so the sandbox can restore the
                // exact bytes (charts, images) after a reload.
                content: text !== null ? text : bytesToBase64(bytes),
                encoding: text !== null ? 'utf8' : 'base64',
                mtime: Date.now()
              });
            } catch (err) {
              if (err && err.name !== 'NotFoundError') console.warn('[DeepUpgrade] VFS read failed:', path, err.message);
            }
          } else {
            await walk(handle, path);
          }
        }
      };
      try {
        await walk(this.root, '');
      } catch (err) {
        console.warn('[DeepUpgrade] VFS listing failed:', err && err.message);
      }
      return out;
    }

    /**
     * Read an OPFS file. A file that is being rewritten at the same time is
     * temporarily unreadable, so a few short retries are needed instead of
     * dropping the file from the result.
     */
    async readBytesWithRetry(handle) {
      let lastError = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const file = await handle.getFile();
          return new Uint8Array(await file.arrayBuffer());
        } catch (err) {
          lastError = err;
          if (err && err.name === 'NotFoundError') break;
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
      throw lastError;
    }

    /**
     * Write bytes to an OPFS file.
     *
     * Two rules matter here: an abandoned writable keeps the file locked
     * forever (every later read fails), and a file that is currently locked by
     * another writer cannot be opened for writing. Both are handled: the
     * writable is always aborted on failure and a locked file is retried.
     */
    async writeBytesWithRetry(handle, bytes) {
      let lastError = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let writable = null;
        try {
          writable = await handle.createWritable();
          await writable.write(bytes);
          await writable.close();
          return;
        } catch (err) {
          lastError = err;
          if (writable) {
            try { await writable.abort(); } catch (e) { /* already closed */ }
          }
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
      throw lastError;
    }

    async dirFor(path, create) {
      const parts = splitPath(path);
      const fileName = parts.pop();
      let dir = this.root;
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: !!create });
      }
      return { dir, fileName };
    }

    /**
     * List the durable tree without reading file contents.
     * Used by the file manager, which needs names, sizes and timestamps only.
     */
    async listAll() {
      await this.init();
      if (this.mode !== 'opfs') {
        return [...this.memory.values()].map((f) => ({
          path: f.path,
          size: f.size || 0,
          mtime: f.mtime || Date.now(),
          encoding: f.encoding || 'utf8'
        }));
      }
      const out = [];
      const walk = async (dirHandle, prefix) => {
        for await (const [name, handle] of dirHandle.entries()) {
          const path = `${prefix}/${name}`;
          if (handle.kind === 'file') {
            try {
              const file = await handle.getFile();
              out.push({
                path,
                size: file.size,
                mtime: file.lastModified || Date.now(),
                encoding: 'utf8'
              });
            } catch (err) { /* file vanished while listing */ }
          } else {
            await walk(handle, path);
          }
        }
      };
      try {
        await walk(this.root, '');
      } catch (err) {
        console.warn('[DeepUpgrade] VFS listing failed:', err && err.message);
      }
      return out;
    }

    /** Read one durable file: { content, encoding, size, mtime }. */
    async readFile(path) {
      await this.init();
      const normalized = '/' + splitPath(path).join('/');
      if (this.mode !== 'opfs') {
        const item = this.memory.get(normalized);
        if (!item) return null;
        return { content: item.content, encoding: item.encoding || 'utf8', size: item.size || 0, mtime: item.mtime || Date.now() };
      }
      try {
        const { dir, fileName } = await this.dirFor(normalized, false);
        const handle = await dir.getFileHandle(fileName);
        const bytes = await this.readBytesWithRetry(handle);
        const text = decodeUtf8OrNull(bytes);
        return {
          content: text !== null ? text : bytesToBase64(bytes),
          encoding: text !== null ? 'utf8' : 'base64',
          size: bytes.byteLength,
          mtime: Date.now()
        };
      } catch (err) {
        return null;
      }
    }

    async writeFile(path, content, encoding) {
      await this.init();
      const isBinary = encoding === 'base64';
      let bytes;
      if (isBinary) {
        bytes = base64ToBytes(content);
      } else {
        bytes = new TextEncoder().encode(typeof content === 'string' ? content : String(content ?? ''));
      }
      if (bytes.length > MAX_FILE_BYTES) {
        throw new Error(`file is larger than ${MAX_FILE_BYTES} bytes and was not persisted`);
      }
      if (this.mode !== 'opfs') {
        this.memory.set(path, {
          path,
          // Keep the same wire format as the OPFS branch: text stays text,
          // binary travels as base64.
          content: isBinary ? bytesToBase64(bytes) : new TextDecoder().decode(bytes),
          encoding: isBinary ? 'base64' : 'utf8',
          size: bytes.byteLength,
          mtime: Date.now()
        });
        return;
      }
      const { dir, fileName } = await this.dirFor(path, true);
      const handle = await dir.getFileHandle(fileName, { create: true });
      await this.writeBytesWithRetry(handle, bytes);
    }

    async removeEntry(path) {
      await this.init();
      if (this.mode !== 'opfs') {
        this.memory.delete(path);
        return;
      }
      const { dir, fileName } = await this.dirFor(path, false);
      try {
        await dir.removeEntry(fileName, { recursive: true });
      } catch (err) {
        if (err && err.name !== 'NotFoundError') throw err;
      }
    }

    async makeDir(path) {
      await this.init();
      if (this.mode !== 'opfs') return;
      const parts = splitPath(path);
      let dir = this.root;
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
    }

    // Serialize mutations so two writes to the same file can never interleave.
    enqueue(job) {
      const run = this.queue.then(job, job);
      this.queue = run.catch(() => {});
      return run;
    }

    // Queued variants for callers outside the mutation pipeline: they must not
    // run while a sandbox mutation is writing the same tree.
    writeFileQueued(path, content, encoding) {
      return this.enqueue(() => this.writeFile(path, content, encoding));
    }

    removeEntryQueued(path) {
      return this.enqueue(() => this.removeEntry(path));
    }

    apply(message) {
      const { op, path, content, encoding } = message || {};
      if (!path) return Promise.resolve({ ok: false, error: 'missing path' });
      const normalized = '/' + splitPath(path).join('/');
      return this.enqueue(async () => {
        try {
          if (op === 'write') {
            await this.writeFile(normalized, content, encoding);
          } else if (op === 'mkdir') {
            await this.makeDir(normalized);
          } else if (op === 'remove') {
            await this.removeEntry(normalized);
          } else {
            return { ok: false, error: `unknown op ${op}` };
          }
          return { ok: true, mode: this.mode };
        } catch (err) {
          console.warn('[DeepUpgrade] VFS persist failed:', op, normalized, err && err.message);
          return { ok: false, error: (err && err.message) || String(err) };
        }
      });
    }

    flush() {
      return this.queue.catch(() => {});
    }
  }

  window.__DU_VFS_STORE = window.__DU_VFS_STORE || new DuVfsStore();
})();
// </du-vfs-store>

// OpenCode User-Defined Skills Engine (Pure Dynamic Registry)
let customSkills = JSON.parse(localStorage.getItem('du_custom_skills') || '[]');
let activeSkills = JSON.parse(localStorage.getItem('du_active_skills') || '[]');

// Deduplicate existing skills in storage on startup
(function sanitizeSkillRegistry() {
  const seen = new Set();
  const cleanList = [];
  for (const s of customSkills) {
    const key = (s.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleanList.push(s);
  }
  if (cleanList.length !== customSkills.length) {
    customSkills = cleanList;
    const validIds = new Set(customSkills.map(s => s.id));
    activeSkills = activeSkills.filter(id => validIds.has(id));
    localStorage.setItem('du_custom_skills', JSON.stringify(customSkills));
    localStorage.setItem('du_active_skills', JSON.stringify(activeSkills));
  }
})();

function getAllSkills() {
  return customSkills;
}

function parseSkillMarkdown(rawText) {
  let name = '';
  let desc = '';
  let prompt = rawText.trim();

  // Parse YAML Frontmatter if present
  const frontmatterMatch = rawText.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1];
    prompt = frontmatterMatch[2].trim();

    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].replace(/['"]/g, '').trim();

    const descMatch = yaml.match(/^description:\s*(.+)$/m);
    if (descMatch) desc = descMatch[1].replace(/['"]/g, '').trim();
  } else {
    // Try to extract first H1 heading
    const h1Match = rawText.match(/^#\s+(.+)$/m);
    if (h1Match) name = h1Match[1].trim();
  }

  // Fallback description from first sentences
  if (!desc) {
    const firstLine = prompt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))[0] || '';
    desc = firstLine.slice(0, 120);
  }

  return {
    name: name || 'Custom Skill',
    desc: desc || 'Custom agent skill',
    prompt: prompt
  };
}

function getSkillSlug(name) {
  return (name || 'skill').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

function syncSkillsToVfs() {
  if (!sandboxIframe || !sandboxIframe.contentWindow) return;
  const all = getAllSkills();
  for (const s of all) {
    const slug = getSkillSlug(s.name);
    const path = `/skills/${slug}/SKILL.md`;
    sandboxIframe.contentWindow.postMessage({
      type: 'DU_MOUNT_SKILL',
      path,
      content: s.prompt || s.desc || ''
    }, '*');
  }
}

/**
 * The list of active skills.
 *
 * This block is small and must be sent with EVERY message: a skill that was
 * installed in the middle of a conversation was never part of the first
 * message, so the model never learned that the rules exist.
 */
function buildSkillsDirective() {
  const all = getAllSkills();
  const enabled = all.filter(s => activeSkills.includes(s.id));
  if (enabled.length === 0) return '';
  return `\n\n[AVAILABLE SKILLS (Loaded in VFS)]:\n` + enabled.map(s => {
    const slug = getSkillSlug(s.name);
    return `- ${s.name}: ${s.desc || s.name} (Rules: /skills/${slug}/SKILL.md)`;
  }).join('\n');
}

function buildSystemDirective() {
  const skillsSection = buildSkillsDirective();

  // Detect whether running in Desktop environment with real OS terminal
  let envHeader = `You have direct access to a high-performance in-browser WebAssembly POSIX sandbox:
- Isolated Virtual File System (VFS mounted at root '/')
- POSIX Shell with core utilities & network access (curl, fetch)
- Python 3.12 (Pyodide WASM runtime with standard libraries)
- JavaScript / Node-compatible async executor`;

  if (window.__DU_DESKTOP__ && window.__DU_DESKTOP__.isDesktop) {
    const desktopCfg = (window.__DU_DESKTOP__ && window.__DU_DESKTOP__.config)
      || (typeof window.__DU_DESKTOP_CONFIG__ === 'object' && window.__DU_DESKTOP_CONFIG__)
      || (typeof getDesktopConfigDirect === 'function' ? getDesktopConfigDirect() : null)
      || {};
    const shellInfo = desktopCfg.shell || { name: 'PowerShell / System Terminal', type: 'powershell' };
    const isPowershell = shellInfo.type === 'powershell' || shellInfo.id === 'powershell' || shellInfo.id === 'pwsh';

    envHeader = `You have DIRECT NATIVE ACCESS to the host computer operating system:
- Current OS: Windows NT x86_64
- Configured Native Shell: ${shellInfo.name} (${shellInfo.path || shellInfo.id})
- Active Working Directory: Local PC Filesystem
${isPowershell ? `- IMPORTANT FOR TERMINAL & DAEMONS:
  * You are running inside Windows PowerShell on the host PC!
  * Use native Windows/PowerShell commands (e.g. "Get-ChildItem -Path C:\\rider", "Select-String", "Test-Path"). Never use "uname -a" or "ls -la /".
  * LONG RUNNING SERVERS / BACKGROUND COMMANDS: If the user asks to start a server (e.g. Python server, Vite, npm, node), DO NOT run "python -m http.server" synchronously, because that will block the terminal execution!
    Instead, launch it in the background using:
    Start-Process python -ArgumentList "-m http.server 8000" -WindowStyle Hidden
    (or Start-Job { python -m http.server 8000 })
    This lets the server run continuously without hanging your response.` : '- IMPORTANT FOR TERMINAL: Use POSIX bash commands. For background servers, append " &" to detach.'}`;
  }

  return `[SYSTEM CAPABILITY: DEEPSEEK LOCAL AGENT RUNTIME ACTIVE]
You are DeepSeek, operating with the DeepUpgrade local execution environment enabled for this session.
${envHeader}

═══════════════════════════════════════════════════════════
TOOL SELECTION & USAGE MATRIX (STRICT ADHERENCE REQUIRED)
═══════════════════════════════════════════════════════════
You MUST choose the most specialized tool for the task. Never use general shell commands when a dedicated file tool exists.

1. "write" - File Creation & Overwrite
   - Usage: When creating new files, saving scripts, writing configs, or complete rewrites.
   - MANDATORY: Always use "write" instead of 'cat << EOF', 'echo >', or python 'open(..., "w")'.
   - Schema:
     \`\`\`json:tool
     { "tool": "write", "path": "/notes/hello.py", "content": "print('hello world')\\n" }
     \`\`\`

2. "edit" - Surgical Code Modifications
   - Usage: When replacing specific lines or functions in an existing file.
   - Rule: "old_str" must exactly match unique text in the file.
   - Schema:
     \`\`\`json:tool
     { "tool": "edit", "path": "/notes/hello.py", "old_str": "print('hello world')", "new_str": "print('hello openCode')" }
     \`\`\`

3. "read" - Inspect File Content
   - Usage: When reading code or configuration files.
   - Schema:
     \`\`\`json:tool
     { "tool": "read", "path": "/notes/hello.py", "offset": 1, "limit": 100 }
     \`\`\`

4. "glob" - File Search by Pattern
   - Usage: Find files by pattern across directories (faster and safer than 'find').
   - Schema:
     \`\`\`json:tool
     { "tool": "glob", "pattern": "**/*.py", "path": "/" }
     \`\`\`

5. "grep" - Search Text Across Files
   - Usage: Search for symbols, function definitions, or strings across the workspace.
   - Schema:
     \`\`\`json:tool
     { "tool": "grep", "pattern": "def main", "path": "/", "include": "*.py" }
     \`\`\`

6. "bash" - Shell Command Execution
   - Usage: For directory traversal (ls, pwd), file inspection, and testing CLI tools.
   - LIMITATION: "git" is NOT available in this sandbox. Use the "js" tool with api.github.com / raw.githubusercontent.com to import repository files one by one.
   - PROHIBITED: Do NOT use bash to create or edit files. Use "write" or "edit".
   - Schema:
     \`\`\`json:tool
     { "tool": "bash", "code": "ls -la /notes" }
     \`\`\`

7. "python" - Scientific Computing, Data & Charts
   - Usage: Running Python logic, calculations, generating SVG/PNG artifacts, data processing.
   - Schema:
     \`\`\`json:tool
     { "tool": "python", "code": "import math\\nprint(math.sqrt(1764))" }
     \`\`\`

8. "js" - Browser & Network Sandbox
   - Usage: Async web requests, JSON APIs, DOM or network experiments.
   - Schema:
     \`\`\`json:tool
     { "tool": "js", "code": "const res = await fetch('https://api.github.com/zen'); console.log(await res.text());" }
     \`\`\`

9. "question" - Interactive Clarification
   - Usage: When user request has multiple valid implementation directions.
   - Schema:
     \`\`\`json:tool
     { "tool": "question", "question": "Какой формат графика предпочтителен?", "options": ["SVG векторный", "PNG растровый"] }
     \`\`\`

10. "todowrite" - Session Working Plan & Task Progress
    - Usage: Proactively create and update a structured todo list whenever a task has 3 or more steps.
    - Status values: "pending", "in_progress", "completed", "cancelled".
    - Schema:
      \`\`\`json:tool
      { "tool": "todowrite", "todos": [
        { "content": "View project structure", "status": "completed" },
        { "content": "Find the translation function", "status": "in_progress" },
        { "content": "Add Spanish language", "status": "pending" }
      ]}
      \`\`\`

11. "install_skill" - Teach Permanent Workflows
    - Schema:
      \`\`\`json:tool
      { "tool": "install_skill", "name": "Skill Name", "desc": "Short description", "prompt": "Instructions..." }
      \`\`\`${skillsSection}

═══════════════════════════════════════════════════════════
EXECUTION PROTOCOL (OPENCODE REACT CONTRACT)
═══════════════════════════════════════════════════════════
1. SINGLE TOOL CALL: Output EXACTLY ONE \`\`\`json:tool codeblock per turn. NEVER output multiple tool blocks in a single message.
2. STRICT STOP: Immediately after closing the tool block (\`\`\`), STOP generating and await the [SANDBOX OUTPUT].
3. NO CONVERSATIONAL FILLER: Do not output conversational preamble before tools (e.g. avoid "Let me write this file for you..."). Directly invoke the tool.
4. ARTIFACTS EMBEDDING: Files generated in VFS (like charts, images, reports) must be linked in your final response using standard markdown links: [График](/chart.svg) or [Отчет](/report.pdf).`;
}

// Handle background network proxy and dynamic skill registration
window.addEventListener('message', async (ev) => {
  if (ev.data && ev.data.type === 'DU_PROXY_FETCH') {
    const { fetchId, url, options } = ev.data;
    try {
      const resp = await fetch(url, options);
      // Read the body as bytes so binary downloads (images, archives) survive
      // the trip; the text form is derived from the same bytes.
      const buffer = await resp.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let text = null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        text = null; // not valid UTF-8 -> binary payload
      }
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      let headersObj = {};
      resp.headers.forEach((v, k) => { headersObj[k] = v; });
      sandboxIframe.contentWindow.postMessage({
        type: 'DU_PROXY_FETCH_RESULT',
        fetchId,
        success: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: headersObj,
        data: text !== null ? text : '',
        dataBase64: btoa(binary),
        isBinary: text === null
      }, '*');
    } catch (err) {
      sandboxIframe.contentWindow.postMessage({
        type: 'DU_PROXY_FETCH_RESULT',
        fetchId,
        success: false,
        error: err.message
      }, '*');
    }
  } else if (ev.data && ev.data.type === 'DU_REGISTER_SKILL') {
    const s = ev.data.skill;
    const existingIndex = customSkills.findIndex(item => item.name && item.name.trim().toLowerCase() === s.name.trim().toLowerCase());
    let skillId;
    if (existingIndex >= 0) {
      skillId = customSkills[existingIndex].id;
      customSkills[existingIndex] = { id: skillId, name: s.name, desc: s.desc, prompt: s.prompt };
    } else {
      skillId = 'custom_' + Date.now().toString(36);
      customSkills.push({ id: skillId, name: s.name, desc: s.desc, prompt: s.prompt });
    }
    if (!activeSkills.includes(skillId)) activeSkills.push(skillId);
    localStorage.setItem('du_custom_skills', JSON.stringify(customSkills));
    localStorage.setItem('du_active_skills', JSON.stringify(activeSkills));
    syncSkillsToVfs();
    publishDirectiveToMainWorld(true);
    if (isSkillsTabActive) renderNativeSkillsContent();
  }
});

// Setup Sandbox Iframe (Universal for Chrome Extension and Android WebView)
let sandboxIframe = null;
let isSandboxReady = false;
const sandboxQueue = [];
function flushSandboxQueue() {
  isSandboxReady = true;
  while (sandboxQueue.length > 0) {
    const fn = sandboxQueue.shift();
    try { fn(); } catch (e) { console.warn('[DeepUpgrade] Sandbox queue dispatch error:', e); }
  }
}
const pendingCalls = new Map();
// File reads requested from the sandbox (DU_GET_FILE -> DU_GET_FILE_RESULT).
const pendingFileRequests = new Map();
const DU_FILE_REQUEST_TIMEOUT = 12000;

// --- shared binary helpers (host page scope) ---
function duBytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function duBase64ToBytes(b64) {
  const binary = atob(String(b64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function duDecodeUtf8OrNull(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- ATTACHED ASSETS (OPFS /added/) ENGINE ---
// Maps file key / name -> { name, path, type, size, isPicture }
const stagedAttachments = new Map();

// Files that live in the durable VFS (uploaded through the file manager or
// left over from an earlier session). The model must know about them too,
// otherwise it looks for an attachment that was never mentioned.
let duStoreAssets = new Map();
let duStoreAssetsCheckedAt = 0;

async function refreshStoreAssets() {
  const now = Date.now();
  if (now - duStoreAssetsCheckedAt < 2000) return;
  duStoreAssetsCheckedAt = now;
  const store = duVfsStore();
  if (!store) return;
  try {
    const files = await store.listAll();
    const next = new Map();
    for (const file of files) {
      if (!file || !file.path || !file.path.startsWith('/added/')) continue;
      next.set(file.path, { type: 'application/octet-stream', size: file.size || 0 });
    }
    duStoreAssets = next;
  } catch (e) { /* listing failed - keep the previous list */ }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'jfif', 'apng', 'pjpeg', 'pjp']);

function isImageFile(filename, mimeType) {
  if (mimeType && mimeType.startsWith('image/')) return true;
  const ext = (filename || '').split('.').pop().toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function sanitizeFileName(name) {
  return (name || 'file').replace(/[\\/:\*\?"<>\|]/g, '_');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function buildAttachedAssetsDirective() {
  if (stagedAttachments.size === 0 && duStoreAssets.size === 0) return '';
  const lines = [];
  const seen = new Set();
  for (const info of stagedAttachments.values()) {
    if (seen.has(info.path)) continue;
    seen.add(info.path);
    lines.push(`- ${info.path} (${info.type || 'application/octet-stream'}, ${formatBytes(info.size)})`);
  }
  for (const [path, info] of duStoreAssets) {
    if (seen.has(path)) continue;
    if (lines.length >= 20) break;
    seen.add(path);
    lines.push(`- ${path} (${info.type || 'application/octet-stream'}, ${formatBytes(info.size)})`);
  }
  if (lines.length === 0) return '';
  return `\n\n[ATTACHED ASSETS AVAILABLE IN VFS]:\n${lines.join('\n')}\n(You can access or inspect these files in python, js, or shell tools)`;
}

window.__DU_GET_SYSTEM_DIRECTIVE__ = function() {
  return `${buildSystemDirective()}${buildAttachedAssetsDirective()}`;
};

// --- Context Limit Configuration ---
const DU_CONTEXT_LIMIT_KEY = 'du_context_limit';
const DU_DEFAULT_CONTEXT_LIMIT = 16000; // 16 KB default

function getContextLimit() {
  try {
    const raw = localStorage.getItem(DU_CONTEXT_LIMIT_KEY);
    if (raw === null) return DU_DEFAULT_CONTEXT_LIMIT;
    const num = parseInt(raw, 10);
    return isNaN(num) ? DU_DEFAULT_CONTEXT_LIMIT : num;
  } catch (e) {
    return DU_DEFAULT_CONTEXT_LIMIT;
  }
}

function setContextLimit(val) {
  try {
    localStorage.setItem(DU_CONTEXT_LIMIT_KEY, String(val));
  } catch (e) {}
}

// --- JavaScript Plugins Engine & ZIP Unpacker ---
const DU_PLUGINS_KEY = 'du_js_plugins';
const pluginTools = new Map();
const pluginHooks = {
  onBeforeSend: [],
  onToolResult: []
};

function duBytesToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 0x8000;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
  }
  return btoa(binary);
}

async function duInflateRaw(compressedBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  let res = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    res.set(c, offset);
    offset += c.length;
  }
  return res;
}

async function duUnpackZip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.length;

  let eocdOffset = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Некорректный ZIP-архив: сигнатура EOCD не найдена.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const files = {};
  let cur = cdOffset;
  const textDecoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntries; i++) {
    const sig = view.getUint32(cur, true);
    if (sig !== 0x02014b50) {
      throw new Error(`Повреждён Central Directory на записи ${i}`);
    }
    const compression = view.getUint16(cur + 10, true);
    const compSize = view.getUint32(cur + 20, true);
    const uncompSize = view.getUint32(cur + 24, true);
    const fileNameLen = view.getUint16(cur + 28, true);
    const extraLen = view.getUint16(cur + 30, true);
    const commentLen = view.getUint16(cur + 32, true);
    const localHeaderOffset = view.getUint32(cur + 42, true);

    const fileNameBytes = bytes.subarray(cur + 46, cur + 46 + fileNameLen);
    let fileName = textDecoder.decode(fileNameBytes).replace(/\\/g, '/');
    cur += 46 + fileNameLen + extraLen + commentLen;

    if (fileName.endsWith('/')) continue;
    fileName = fileName.replace(/^\/+/, '');

    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`Повреждён локальный заголовок для ${fileName}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedData = bytes.subarray(dataStart, dataStart + compSize);

    let uncompressedBytes;
    if (compression === 0) {
      uncompressedBytes = compressedData;
    } else if (compression === 8) {
      uncompressedBytes = await duInflateRaw(compressedData);
    } else {
      throw new Error(`Неподдерживаемый метод сжатия (${compression}) для ${fileName}`);
    }

    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(uncompressedBytes);
    } catch (e) {
      text = null;
    }

    files[fileName] = {
      name: fileName,
      size: uncompSize,
      isBinary: text === null,
      text: text,
      base64: text === null ? duBytesToBase64(uncompressedBytes) : null
    };
  }

  return files;
}

function duNormalizeZipEntries(rawFiles) {
  const keys = Object.keys(rawFiles);
  if (keys.length === 0) return rawFiles;

  const firstSlash = keys[0].indexOf('/');
  if (firstSlash > 0) {
    const commonPrefix = keys[0].slice(0, firstSlash + 1);
    const allShare = keys.every(k => k.startsWith(commonPrefix));
    if (allShare) {
      const stripped = {};
      for (const [k, v] of Object.entries(rawFiles)) {
        const newKey = k.slice(commonPrefix.length);
        if (newKey) {
          v.name = newKey;
          stripped[newKey] = v;
        }
      }
      return stripped;
    }
  }
  return rawFiles;
}

async function duInstallPluginFromZip(arrayBuffer, originalFileName = 'plugin.zip') {
  const rawFiles = await duUnpackZip(arrayBuffer);
  const files = duNormalizeZipEntries(rawFiles);
  if (Object.keys(files).length === 0) {
    throw new Error('Архив пуст.');
  }

  let manifest = {};
  const manifestFile = files['plugin.json'] || files['manifest.json'] || files['package.json'];
  if (manifestFile && manifestFile.text) {
    try {
      manifest = JSON.parse(manifestFile.text);
    } catch (e) {
      console.warn('[DeepUpgrade] Ошибка парсинга plugin.json:', e);
    }
  }

  let entryFileName = manifest.main;
  if (!entryFileName || !files[entryFileName]) {
    const candidates = ['index.js', 'main.js', 'plugin.js'];
    entryFileName = candidates.find(c => files[c]) || Object.keys(files).find(k => k.endsWith('.js') && !k.includes('/'));
    if (!entryFileName) {
      entryFileName = Object.keys(files).find(k => k.endsWith('.js'));
    }
  }

  if (!entryFileName || !files[entryFileName]) {
    throw new Error('В архиве не найден исполняемый JavaScript-файл (.js). Добавьте index.js или укажите "main" в plugin.json.');
  }

  const entryFile = files[entryFileName];
  if (!entryFile.text) {
    throw new Error(`Файл точки входа ${entryFileName} пуст или является бинарным.`);
  }

  // Note: Syntax validation via 'new Function' is intentionally omitted here because
  // host page CSP forbids 'unsafe-eval'. Full evaluation occurs inside the sandboxed runner.html iframe.

  const name = manifest.name || originalFileName.replace(/\.zip$/i, '') || 'Unnamed Plugin';
  const desc = manifest.description || `ZIP-плагин (${Object.keys(files).length} файлов)`;
  const version = manifest.version || '1.0.0';
  const pluginId = 'plug_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  const serializableFiles = {};
  for (const [k, v] of Object.entries(files)) {
    serializableFiles[k] = {
      name: k,
      size: v.size,
      isBinary: v.isBinary,
      text: v.text,
      base64: v.base64
    };
  }

  const newPlugin = {
    id: pluginId,
    name,
    desc,
    version,
    entryFile: entryFileName,
    code: entryFile.text,
    files: serializableFiles,
    enabled: true,
    createdAt: Date.now()
  };

  const allPlugins = getStoredPlugins();
  const existingIdx = allPlugins.findIndex(p => p.name === name);
  if (existingIdx !== -1) {
    newPlugin.id = allPlugins[existingIdx].id;
    allPlugins[existingIdx] = newPlugin;
  } else {
    allPlugins.push(newPlugin);
  }

  saveStoredPlugins(allPlugins);
  reloadAllPlugins();
  duMountPluginToVfs(newPlugin);
  return newPlugin;
}

function duMountPluginToVfs(plugin) {
  if (!plugin || !plugin.files) return;
  const store = typeof duVfsStore === 'function' ? duVfsStore() : null;
  for (const [relPath, file] of Object.entries(plugin.files)) {
    const vfsPath = `/plugins/${plugin.id}/${relPath}`;
    const content = file.isBinary ? (file.base64 || '') : (file.text || '');
    const encoding = file.isBinary ? 'base64' : 'utf8';
    if (store && store.writeFileQueued) {
      store.writeFileQueued(vfsPath, content, encoding).catch(() => {});
    }
    if (sandboxIframe && sandboxIframe.contentWindow) {
      try {
        sandboxIframe.contentWindow.postMessage({
          type: 'DU_STORE_ATTACHMENT',
          path: vfsPath,
          data: content,
          isBinary: file.isBinary
        }, '*');
      } catch (e) {}
    }
  }
}

function getStoredPlugins() {
  try {
    const raw = localStorage.getItem(DU_PLUGINS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveStoredPlugins(plugins) {
  try {
    localStorage.setItem(DU_PLUGINS_KEY, JSON.stringify(plugins));
  } catch (e) {
    console.warn('[DeepUpgrade] Failed to save plugins to localStorage:', e);
  }
}

function createPluginApi(plugin) {
  const pluginFiles = plugin.files || {};

  const getAsset = (relPath, format = 'auto') => {
    const cleanPath = String(relPath || '').replace(/^[./\\]+/, '');
    const entry = pluginFiles[cleanPath] || pluginFiles[relPath];
    if (!entry) return null;
    if (format === 'text') return entry.text || '';
    if (format === 'base64') return entry.base64 || '';
    if (format === 'dataurl') {
      const ext = cleanPath.split('.').pop().toLowerCase();
      const mime = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp',
        json: 'application/json', css: 'text/css', html: 'text/html',
        js: 'text/javascript'
      }[ext] || 'application/octet-stream';
      return `data:${mime};base64,${entry.base64 || ''}`;
    }
    if (!entry.isBinary) return entry.text;
    return entry.base64;
  };

  const requireModule = (relPath) => {
    const cleanPath = String(relPath || '').replace(/^[./\\]+/, '');
    const targetPath = cleanPath.endsWith('.js') ? cleanPath : cleanPath + '.js';
    const entry = pluginFiles[targetPath] || pluginFiles[cleanPath];
    if (!entry) {
      throw new Error(`[Plugin ${plugin.name}] Cannot find module '${relPath}' in ZIP assets`);
    }
    const module = { exports: {} };
    const fn = new Function('module', 'exports', 'require', 'DeepUpgrade', entry.text);
    fn(module, module.exports, requireModule, api);
    return module.exports;
  };

  const injectCSS = (pathOrCSS) => {
    let cssText = pathOrCSS;
    const cleanPath = String(pathOrCSS || '').replace(/^[./\\]+/, '');
    if (pluginFiles[cleanPath] && pluginFiles[cleanPath].text) {
      cssText = pluginFiles[cleanPath].text;
    }
    const styleId = `du-plugin-style-${plugin.id}`;
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssText;
    return styleEl;
  };

  const api = {
    plugin: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version || '1.0.0',
      description: plugin.desc || ''
    },
    files: pluginFiles,
    getAsset,
    getFile: getAsset,
    require: requireModule,
    injectCSS,
    registerTool: (def) => {
      if (!def || !def.name || typeof def.execute !== 'function') {
        throw new Error('Plugin tool must provide "name" and "execute" function');
      }
      pluginTools.set(def.name, {
        name: def.name,
        description: def.description || 'Custom plugin tool',
        parameters: def.parameters || def.params || null,
        icon: def.icon || 'plugin',
        execute: def.execute,
        pluginId: plugin.id
      });
      if (typeof KNOWN_TOOL_NAMES !== 'undefined' && KNOWN_TOOL_NAMES.add) {
        KNOWN_TOOL_NAMES.add(def.name);
      }
    },
    defineTool: (def) => api.registerTool(def),
    tool: (def) => api.registerTool(def),
    http: createHttpClient(),
    fetch: duPrivilegedFetch,
    unregisterTool: (name) => {
      pluginTools.delete(name);
      if (typeof KNOWN_TOOL_NAMES !== 'undefined' && KNOWN_TOOL_NAMES.delete) {
        KNOWN_TOOL_NAMES.delete(name);
      }
    },
    onBeforeSend: (fn) => {
      if (typeof fn === 'function') pluginHooks.onBeforeSend.push(fn);
    },
    onToolResult: (fn) => {
      if (typeof fn === 'function') pluginHooks.onToolResult.push(fn);
    },
    storage: {
      get: (key, fallback) => {
        try {
          const val = localStorage.getItem(`du_plug_${plugin.id}_${key}`);
          return val !== null ? JSON.parse(val) : fallback;
        } catch (e) { return fallback; }
      },
      set: (key, val) => {
        try {
          localStorage.setItem(`du_plug_${plugin.id}_${key}`, JSON.stringify(val));
        } catch (e) {}
      }
    }
  };
  return api;
}

async function duPrivilegedFetch(url, options = {}) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: 'DU_FETCH',
          url,
          options,
          responseType: options.responseType || 'json'
        }, (res) => {
          if (chrome.runtime.lastError || !res) {
            duFallbackFetch(url, options).then(resolve).catch(reject);
            return;
          }
          if (!res.ok && res.error) {
            reject(new Error(res.error));
            return;
          }
          resolve({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            headers: res.headers || {},
            data: res.data,
            text: async () => res.text,
            json: async () => (typeof res.data === 'string' ? JSON.parse(res.data) : res.data),
            base64: res.base64
          });
        });
      } catch (err) {
        duFallbackFetch(url, options).then(resolve).catch(reject);
      }
    });
  }
  return duFallbackFetch(url, options);
}

async function duFallbackFetch(url, options = {}) {
  const fetchOpts = { ...options };
  if (fetchOpts.body && typeof fetchOpts.body === 'object') {
    fetchOpts.body = JSON.stringify(fetchOpts.body);
  }
  const resp = await fetch(url, fetchOpts);
  const text = await resp.text();
  let data = text;
  try { data = JSON.parse(text); } catch (e) {}
  const headers = {};
  if (resp.headers && resp.headers.forEach) {
    resp.headers.forEach((v, k) => { headers[k] = v; });
  }
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers,
    data,
    text: async () => text,
    json: async () => data
  };
}

function createHttpClient() {
  const request = async (url, options = {}) => {
    let finalUrl = url;
    if (options.params && typeof options.params === 'object') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) q.append(k, String(v));
      }
      const qs = q.toString();
      if (qs) finalUrl += (finalUrl.includes('?') ? '&' : '?') + qs;
    }
    const headers = { 'Accept': 'application/json, text/plain, */*', ...(options.headers || {}) };
    const res = await duPrivilegedFetch(finalUrl, { ...options, headers });
    return res;
  };

  const get = async (url, params = null, options = {}) => {
    const res = await request(url, { ...options, method: 'GET', params });
    if (!res.ok) {
      throw new Error(`HTTP GET ${url} failed with status ${res.status}: ${res.statusText || ''}`);
    }
    return res.data;
  };

  const post = async (url, body = null, options = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await request(url, { ...options, method: 'POST', body, headers });
    if (!res.ok) {
      throw new Error(`HTTP POST ${url} failed with status ${res.status}: ${res.statusText || ''}`);
    }
    return res.data;
  };

  return { request, get, post, fetch: duPrivilegedFetch };
}

function reloadAllPlugins() {
  pluginTools.clear();
  pluginHooks.onBeforeSend = [];
  pluginHooks.onToolResult = [];

  const plugins = getStoredPlugins();
  for (const p of plugins) {
    if (!p.enabled) continue;
    duMountPluginToVfs(p);
  }

  // Dynamic code evaluation ('new Function') violates DeepSeek host page CSP ('unsafe-eval' prohibition).
  // Delegate plugin evaluation and execution to the sandboxed runner.html iframe, which has its own sandbox CSP.
  if (!sandboxIframe || !sandboxIframe.parentNode) {
    initSandboxIframe();
  }
  if (sandboxIframe && sandboxIframe.contentWindow) {
    try {
      sandboxIframe.contentWindow.postMessage({
        type: 'DU_REGISTER_PLUGINS',
        plugins: plugins.filter(p => p.enabled)
      }, '*');
    } catch (e) {}
  }
}

function buildPluginToolsDirective() {
  if (pluginTools.size === 0) return '';
  const blocks = [];
  for (const [name, def] of pluginTools) {
    let block = `- "${name}": ${def.description || 'Custom JS Plugin Tool'}`;
    const params = def.parameters;
    if (params) {
      const paramLines = [];
      const exampleObj = { tool: name };

      if (params.type === 'object' && params.properties) {
        const req = new Set(params.required || []);
        for (const [pName, pSchema] of Object.entries(params.properties)) {
          const isReq = req.has(pName) ? 'обязательно' : 'опционально';
          const pType = pSchema.type || 'string';
          const pDesc = pSchema.description ? `: ${pSchema.description}` : '';
          paramLines.push(`    - ${pName} (${pType}, ${isReq})${pDesc}`);
          exampleObj[pName] = pSchema.default !== undefined ? pSchema.default : (pType === 'number' ? 0 : pType === 'boolean' ? true : `value_${pName}`);
        }
      } else if (typeof params === 'object') {
        for (const [pName, pVal] of Object.entries(params)) {
          if (typeof pVal === 'string') {
            paramLines.push(`    - ${pName}: ${pVal}`);
            exampleObj[pName] = `value_${pName}`;
          } else if (typeof pVal === 'object' && pVal) {
            const isReq = pVal.required ? 'обязательно' : 'опционально';
            const pType = pVal.type || 'string';
            const pDesc = pVal.description ? `: ${pVal.description}` : '';
            paramLines.push(`    - ${pName} (${pType}, ${isReq})${pDesc}`);
            exampleObj[pName] = pVal.default !== undefined ? pVal.default : (pType === 'number' ? 0 : `value_${pName}`);
          }
        }
      }

      if (paramLines.length > 0) {
        block += '\n  Параметры:\n' + paramLines.join('\n');
        block += `\n  Пример вызова: {"tool": "${name}", ${Object.entries(exampleObj).filter(([k]) => k !== 'tool').map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ')}}`;
      }
    }
    blocks.push(block);
  }
  return `\n\n[AVAILABLE JS PLUGIN TOOLS]:\n` + blocks.join('\n\n') + '\n(You can invoke any of these custom tools using the standard ```json:tool schema)';
}

/**
 * The directive for one turn.
 * The first message carries the full system prompt, every later message still
 * carries the skill list and the attached assets.
 */
function buildTurnDirective(isFirstTurn) {
  return (isFirstTurn ? buildSystemDirective() : '')
    + buildSkillsDirective()
    + buildPluginToolsDirective()
    + buildAttachedAssetsDirective();
}

// --- MAIN world bridge ---
// The interceptor (MAIN world) cannot see the functions of this content
// script (isolated world), so it always fell back to its own short directive
// without the skill list. The full directive is published into the page's
// localStorage, which both worlds share.
const DU_DIRECTIVE_KEY = 'du_system_directive_v2';
let duDirectiveSignature = '';

function publishDirectiveToMainWorld(force) {
  try {
    const signature = JSON.stringify({
      skills: getAllSkills().map(s => [s.id, s.name, s.desc, activeSkills.includes(s.id)]),
      assets: [...stagedAttachments.values()].map(a => a.path),
      store: [...duStoreAssets.keys()],
      plugins: [...pluginTools.keys()]
    });
    if (!force && signature === duDirectiveSignature) return;
    duDirectiveSignature = signature;
    localStorage.setItem(DU_DIRECTIVE_KEY, JSON.stringify({
      ts: Date.now(),
      system: buildSystemDirective(),
      skills: buildSkillsDirective() + buildPluginToolsDirective(),
      assets: buildAttachedAssetsDirective()
    }));
  } catch (e) { /* storage full or blocked - the composer prefix still works */ }
}

// Clean up files in VFS older than configured days
function runAttachmentCleanup() {
  const days = parseInt(localStorage.getItem('du_cleanup_days') ?? '7', 10);
  if (days <= 0) return; // 0 means Never
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  if (sandboxIframe && sandboxIframe.contentWindow) {
    sandboxIframe.contentWindow.postMessage({
      type: 'DU_CLEANUP_ATTACHMENTS',
      maxAgeMs
    }, '*');
  }
}

// Listen for popup settings changes
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'set_cleanup_days') {
      localStorage.setItem('du_cleanup_days', msg.days);
      runAttachmentCleanup();
    } else if (msg && msg.action === 'set_block_telemetry') {
      localStorage.setItem('du_block_telemetry', JSON.stringify(msg.value));
    } else if (msg && msg.action === 'set_agent_enabled') {
      // The popup switch goes through the shared bridge, so the page mirror,
      // the durable storage and the MAIN-world interceptor stay in sync.
      if (typeof window.__DU_SETTINGS__ !== 'undefined') {
        window.__DU_SETTINGS__.setEnabled(!!msg.value);
      }
    } else if (msg && msg.action === 'set_theme') {
      if (typeof window.__DU_THEME__ !== 'undefined') {
        window.__DU_THEME__.apply(msg.theme);
      }
    }
  });
}

function handleFileInputChange(fileInput) {
  const files = fileInput.files;
  if (!files || files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isPic = isImageFile(file.name, file.type);
    const safeName = sanitizeFileName(file.name);
    const targetFolder = isPic ? '/added/picture' : '/added/file';
    const vfsPath = `${targetFolder}/${safeName}`;

    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target.result;
      // Convert ArrayBuffer to binary string / base64 for postMessage transfer
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let j = 0; j < len; j++) {
        binary += String.fromCharCode(bytes[j]);
      }
      const base64Data = btoa(binary);

      stagedAttachments.set(safeName, {
        name: file.name,
        path: vfsPath,
        type: file.type || (isPic ? 'image/png' : 'application/octet-stream'),
        size: file.size,
        isPicture: isPic,
        mtime: Date.now()
      });
      publishDirectiveToMainWorld(true);

      if (sandboxIframe && sandboxIframe.contentWindow) {
        sandboxIframe.contentWindow.postMessage({
          type: 'DU_STORE_ATTACHMENT',
          path: vfsPath,
          data: base64Data,
          isBinary: true,
          mtime: Date.now()
        }, '*');
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function hookAttachmentElements() {
  // 1. Hook hidden file input
  const fileInputs = document.querySelectorAll('input[type="file"]');
  fileInputs.forEach(input => {
    if (input.hasAttribute('data-du-hooked')) return;
    input.setAttribute('data-du-hooked', 'true');
    input.addEventListener('change', () => {
      handleFileInputChange(input);
    });
  });

  // 2. Track chips in input container and remove files when chip is dismissed
  if (stagedAttachments.size > 0) {
    const inputArea = document.querySelector('._871cbca') || document.querySelector('div:has(textarea)');
    if (inputArea) {
      // Find all file chip cards in DeepSeek UI
      const chipElements = inputArea.querySelectorAll('div[class*="file"], div[class*="upload"], div[class*="tag"], div[class*="chip"]');
      const currentChipTexts = Array.from(chipElements).map(el => el.innerText || '');

      for (const [key, info] of stagedAttachments.entries()) {
        // Files uploaded through the file manager are not chat attachments and
        // have no chip in the composer, so they must survive the cleanup.
        if (info.fromFileManager) continue;
        // If the chip is no longer present in inputArea DOM
        const stillInDom = currentChipTexts.some(txt => txt.includes(info.name) || txt.includes(key));
        if (!stillInDom && chipElements.length > 0) {
          // File was dismissed/unattached by user before sending!
          if (sandboxIframe && sandboxIframe.contentWindow) {
            sandboxIframe.contentWindow.postMessage({
              type: 'DU_REMOVE_ATTACHMENT',
              path: info.path
            }, '*');
          }
          stagedAttachments.delete(key);
          publishDirectiveToMainWorld(true);
        }
      }
    }
  }
}

// --- DURABLE VFS (OPFS, owned by this page) ---
// The sandbox iframe has a unique origin and cannot reach OPFS, so the page
// keeps the durable copy and answers hydrate/mutation requests from the runner.
function duVfsStore() {
  return window.__DU_VFS_STORE || null;
}

async function handleVfsBoot(ev) {
  const store = duVfsStore();
  const reply = (payload) => {
    try { ev.source && ev.source.postMessage({ type: 'DU_VFS_SNAPSHOT', ...payload }, '*'); } catch (e) {}
  };
  try {
    if (!store) return reply({ files: [], mode: 'memory' });
    const mode = await store.init();
    const files = await store.loadAll();
    reply({ files, mode });
  } catch (err) {
    console.warn('[DeepUpgrade] VFS hydrate failed:', err);
    reply({ files: [], mode: 'memory' });
  }
}

async function handleVfsMutation(ev, data) {
  const store = duVfsStore();
  const reply = (payload) => {
    try { ev.source && ev.source.postMessage({ type: 'DU_VFS_MUTATED', reqId: data.reqId, ...payload }, '*'); } catch (e) {}
  };
  if (!store) return reply({ ok: false, error: 'vfs store unavailable' });
  const result = await store.apply(data);
  reply(result);
}

function initSandboxIframe() {
  if (sandboxIframe && sandboxIframe.parentNode) return;
  sandboxIframe = document.createElement('iframe');
  
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    sandboxIframe.src = chrome.runtime.getURL('sandbox/runner.html');
  } else if (window.__DU_RUNNER_HTML__) {
    sandboxIframe.srcdoc = window.__DU_RUNNER_HTML__;
  } else {
    sandboxIframe.src = 'about:blank';
  }

  sandboxIframe.style.display = 'none';
  sandboxIframe.onload = () => {
    flushSandboxQueue();
    syncSkillsToVfs();
    // Send persistent packages to sandbox
    const savedPackages = JSON.parse(localStorage.getItem('du_persistent_packages') || '[]');
    sandboxIframe.contentWindow.postMessage({
      type: 'DU_SET_PERSISTENT_PACKAGES',
      packages: savedPackages
    }, '*');
    reloadAllPlugins();
  };
  (document.body || document.documentElement).appendChild(sandboxIframe);

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.id && pendingCalls.has(ev.data.id)) {
      const resolver = pendingCalls.get(ev.data.id);
      pendingCalls.delete(ev.data.id);
      resolver(ev.data);
    } else if (ev.data && ev.data.type === 'DU_GET_FILE_RESULT' && pendingFileRequests.has(ev.data.reqId)) {
      const resolver = pendingFileRequests.get(ev.data.reqId);
      pendingFileRequests.delete(ev.data.reqId);
      resolver(ev.data);
    } else if (ev.data && ev.data.type === 'DU_PERSIST_PACKAGES') {
      const current = new Set(JSON.parse(localStorage.getItem('du_persistent_packages') || '[]'));
      for (const p of ev.data.packages) current.add(p);
      localStorage.setItem('du_persistent_packages', JSON.stringify([...current]));
    } else if (ev.data && ev.data.type === 'DU_VFS_BOOT') {
      flushSandboxQueue();
      handleVfsBoot(ev);
    } else if (ev.data && ev.data.type === 'DU_VFS_MUTATE') {
      handleVfsMutation(ev, ev.data);
    } else if (ev.data && ev.data.type === 'DU_PLUGINS_REGISTERED') {
      const { tools } = ev.data;
      if (Array.isArray(tools)) {
        for (const t of tools) {
          pluginTools.set(t.name, {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            icon: t.icon,
            execute: async (args) => {
              const res = await runInSandbox({ tool: t.name, args });
              return res.output || res;
            }
          });
          if (typeof KNOWN_TOOL_NAMES !== 'undefined') KNOWN_TOOL_NAMES.add(t.name);
        }
        if (typeof publishDirectiveToMainWorld === 'function') {
          publishDirectiveToMainWorld(true);
        }
      }
    } else if (ev.data && ev.data.type === 'DU_INJECT_CSS') {
      const { pluginId, css } = ev.data;
      if (pluginId && css) {
        const styleId = `du-plugin-style-${pluginId}`;
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = styleId;
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
      }
    }
  });
}
initSandboxIframe();

// Keep the durable VFS consistent if the tab is closed mid-write.
window.addEventListener('pagehide', () => {
  const store = duVfsStore();
  if (store) store.flush();
});

/**
 * Read a file the tools produced.
 *
 * The sandbox (unique origin) owns the live copy, the host page owns the
 * durable OPFS copy. The sandbox answers first because it also sees files
 * that were not persisted yet; the durable store is the fallback, so cards
 * and downloads keep working after a reload.
 */
async function resolveDurableFile(path) {
  const store = duVfsStore();
  if (!store) return { success: false, error: 'vfs store unavailable' };
  try {
    const file = await store.readFile(path);
    if (!file) return { success: false, error: 'File not found' };
    const base64 = file.encoding === 'base64'
      ? file.content
      : duBytesToBase64(new TextEncoder().encode(file.content));
    return { success: true, path: file.path || path, size: file.size, base64 };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
}

function fetchFileFromSandbox(path) {
  return new Promise((resolve) => {
    const done = (res) => resolve(res || { success: false, error: 'File not found' });

    if (!sandboxIframe || !sandboxIframe.contentWindow) {
      resolveDurableFile(path).then(done);
      return;
    }

    const reqId = 'f' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      if (pendingFileRequests.has(reqId)) {
        pendingFileRequests.delete(reqId);
        resolveDurableFile(path).then(done);
      }
    }, DU_FILE_REQUEST_TIMEOUT);

    pendingFileRequests.set(reqId, (res) => {
      clearTimeout(timer);
      if (res && res.success) {
        done(res);
        return;
      }
      resolveDurableFile(path).then(done);
    });

    try {
      sandboxIframe.contentWindow.postMessage({ type: 'DU_GET_FILE', reqId, path }, '*');
    } catch (err) {
      clearTimeout(timer);
      pendingFileRequests.delete(reqId);
      resolveDurableFile(path).then(done);
    }
  });
}

function runInSandbox(toolObj) {
  // If running in DeepUpgrade Desktop, route directly to real OS terminal & FS!
  if (window.__DU_DESKTOP__ && window.__DU_DESKTOP__.isDesktop) {
    return new Promise(async (resolve) => {
      const id = Math.random().toString(36).slice(2);
      const name = toolObj.name || toolObj.tool;
      const args = toolObj.args || {};

      try {
        if (name === 'bash' || name === 'sh' || name === 'terminal' || name === 'exec' || name === 'powershell' || name === 'cmd') {
          const cmd = args.command || args.cmd || toolObj.command || toolObj.code || '';
          const cwd = args.cwd || localStorage.getItem('du_desktop_cwd') || undefined;
          const res = await window.__DU_DESKTOP__.terminal.exec(cmd, cwd);
          const out = (res.stdout || '') + (res.stderr ? (res.stdout ? '\n' : '') + res.stderr : '');
          resolve({
            id,
            success: res.ok,
            output: out || (res.ok ? '(command completed with no output)' : `Exit code: ${res.exitCode}`)
          });
          return;
        }

        if (name === 'write' || name === 'write_file' || name === 'create_file') {
          const path = args.path || toolObj.path || args.filePath || '';
          const content = args.content ?? toolObj.content ?? args.file_text ?? args.text ?? toolObj.text ?? '';
          const res = await window.__DU_DESKTOP__.fs.writeFile(path, content);
          resolve({
            id,
            success: res.ok,
            output: res.ok ? `Successfully wrote ${content.length} characters to '${path}'.` : `Write error: ${res.error}`
          });
          return;
        }

        if (name === 'read' || name === 'read_file' || name === 'view_file') {
          const path = args.path || toolObj.path || args.filePath || '';
          const res = await window.__DU_DESKTOP__.fs.readFile(path);
          if (!res.ok) {
            resolve({ id, success: false, output: `Read error: ${res.error}` });
            return;
          }
          const raw = res.data || '';
          const offset = Math.max(1, parseInt(args.offset || toolObj.offset || '1', 10));
          const limit = (args.limit !== undefined || toolObj.limit !== undefined)
            ? parseInt(args.limit || toolObj.limit, 10)
            : 2000;
          const allLines = raw.split('\n');
          const totalLines = allLines.length;
          const slice = allLines.slice(offset - 1, offset - 1 + limit);
          let formatted = slice.map((line, idx) => {
            const lineNum = (offset + idx).toString().padStart(5, ' ');
            return `${lineNum} | ${line}`;
          }).join('\n');
          if (offset + limit <= totalLines) {
            formatted += `\n... [${totalLines - (offset - 1 + limit)} more lines. Use offset=${offset + limit} to continue]`;
          }
          resolve({
            id,
            success: true,
            output: formatted
          });
          return;
        }

        if (name === 'edit' || name === 'edit_file') {
          const path = args.path || toolObj.path || '';
          const oldStr = args.old_str ?? toolObj.old_str ?? args.oldStr ?? '';
          const newStr = args.new_str ?? toolObj.new_str ?? args.newStr ?? '';
          const readRes = await window.__DU_DESKTOP__.fs.readFile(path);
          if (!readRes.ok) {
            resolve({ id, success: false, output: `Edit error reading file: ${readRes.error}` });
            return;
          }
          const fileContent = readRes.data || '';
          if (!fileContent.includes(oldStr)) {
            resolve({ id, success: false, output: `Edit error: old_str was not found in '${path}'.` });
            return;
          }
          const updated = fileContent.replace(oldStr, newStr);
          const writeRes = await window.__DU_DESKTOP__.fs.writeFile(path, updated);
          resolve({
            id,
            success: writeRes.ok,
            output: writeRes.ok ? `Successfully replaced text in '${path}'.` : `Edit error writing file: ${writeRes.error}`
          });
          return;
        }

        if (name === 'list_files' || name === 'ls') {
          const path = args.path || toolObj.path || args.dirPath || '.';
          const res = await window.__DU_DESKTOP__.fs.listDir(path);
          resolve({
            id,
            success: res.ok,
            output: res.ok ? res.entries.map(e => (e.isDirectory ? '[DIR] ' : '') + e.name).join('\n') : `List error: ${res.error}`
          });
          return;
        }

        // Fallback to real terminal execution for any other command
        const fallbackCmd = args.command || args.cmd || toolObj.command || toolObj.code || JSON.stringify(args);
        const cwd = args.cwd || localStorage.getItem('du_desktop_cwd') || undefined;
        const res = await window.__DU_DESKTOP__.terminal.exec(fallbackCmd, cwd);
        resolve({
          id,
          success: res.ok,
          output: res.stdout || res.stderr || 'Executed'
        });
      } catch (err) {
        resolve({ id, success: false, output: `Desktop Bridge Error: ${err.message}` });
      }
    });
  }

  // Otherwise browser/sandbox iframe execution
  return new Promise((resolve) => {
    if (!sandboxIframe || !sandboxIframe.parentNode) {
      initSandboxIframe();
    }
    const id = Math.random().toString(36).slice(2);

    // A hung Pyodide/WASM call must never freeze the ReAct loop silently.
    const timeout = setTimeout(() => {
      if (pendingCalls.has(id)) {
        pendingCalls.delete(id);
        resolve({ id, success: false, output: 'Sandbox timeout: runner.html did not answer within 120s.' });
      }
    }, 120000);

    pendingCalls.set(id, (res) => {
      clearTimeout(timeout);
      resolve(res);
    });

    const dispatchRun = () => {
      try {
        if (!sandboxIframe.parentNode) {
          (document.body || document.documentElement).appendChild(sandboxIframe);
        }
        sandboxIframe.contentWindow.postMessage({
          id,
          type: 'DU_RUN',
          ...toolObj
        }, '*');
      } catch(err) {
        pendingCalls.delete(id);
        clearTimeout(timeout);
        resolve({ id, success: false, output: `Sandbox dispatch error: ${err.message}` });
      }
    };

    if (isSandboxReady && sandboxIframe && sandboxIframe.contentWindow) {
      dispatchRun();
    } else {
      sandboxQueue.push(dispatchRun);
    }
  });
}

// <du-tool-dedupe>
// Dedupe is scoped to the user turn, not to the whole session. A legitimate
// retry ("пробуй вновь") repeats the same command text and must execute again,
// while a React re-render or a reload of the same turn must not. One tool call
// per assistant answer is also enforced: executing several blocks from one
// answer in parallel sends their outputs out of order, so the model receives the
// wrong output for the wrong tool.
const EXECUTED_KEY = 'du_executed_turns_v3';
const EXECUTED_OUTPUT_KEY = 'du_executed_tool_outputs_v3';
const EXECUTED_BLOCKS_KEY = 'du_executed_tool_blocks_v3';

function readJsonStorage(key, fallback) {
  try {
    const raw = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key)) ||
                (typeof localStorage !== 'undefined' && localStorage.getItem(key));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (e) {
    return fallback;
  }
}

const executedTurns = new Set(readJsonStorage(EXECUTED_KEY, []));
const executedOutputs = new Map(readJsonStorage(EXECUTED_OUTPUT_KEY, []));
// Exact tool blocks that already ran. A single answer may contain several
// calls; each of them must run once, but never twice after a re-render.
const executedBlocks = new Set(readJsonStorage(EXECUTED_BLOCKS_KEY, []));

function hashText(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Identify the user turn that produced this assistant answer. Our own silent
 * replies are user messages too, so every tool result starts its own turn and a
 * retried command is never mistaken for the previous one.
 */
function getToolTurnKey(block) {
  let scope = '';
  let bubbles = document.querySelectorAll('.fbb737a4');
  if (bubbles.length === 0) {
    bubbles = document.querySelectorAll('.ds-message:not(:has(.ds-markdown)), [data-virtual-list-item-key]:not(:has(.ds-markdown))');
  }
  for (const bubble of bubbles) {
    if (bubble.contains(block)) continue;
    if (bubble.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
      // textContent (not innerText) so hidden silent replies still count.
      scope = 'u:' + hashText((bubble.textContent || '').replace(/\s+/g, ' ').trim().slice(-300));
    }
  }

  if (!scope) {
    // Fallback when the user-bubble class changes: use this message's prose.
    // Code blocks and widgets are stripped so the key survives re-renders.
    const bubble = block.closest('.ds-message') || block.closest('[data-virtual-list-item-key]');
    if (bubble) {
      const clone = bubble.cloneNode(true);
      clone.querySelectorAll('.md-code-block, pre, .opencode-tool-root').forEach((node) => node.remove());
      scope = 'm:' + hashText((clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300));
    }
  }

  return `${location.pathname}|${scope || 'root'}`;
}

function getToolBlockKey(block, blockHash) {
  return `${getToolTurnKey(block)}|${blockHash}`;
}

/**
 * A tool call may only run while its answer is the active turn. As soon as a
 * newer user message exists (including our own [SANDBOX OUTPUT] reply), the call
 * is history and must never run again.
 */
function isLatestAssistantBlock(block) {
  let bubbles = document.querySelectorAll('.fbb737a4');
  if (bubbles.length === 0) {
    bubbles = document.querySelectorAll('.ds-message:not(:has(.ds-markdown)), [data-virtual-list-item-key]:not(:has(.ds-markdown))');
  }
  for (const bubble of bubbles) {
    if (bubble.contains(block)) continue;
    if (block.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
  }
  return true;
}

/**
 * Blocks that already exist when the script loads belong to chat history (or to
 * a reloaded turn). Never auto-run them: just remember their turns as done.
 */
function seedHistoricalExecutions() {
  document.querySelectorAll('.md-code-block, pre').forEach((block) => {
    const codeText = block.innerText || '';
    if (!/"tool"\s*:/.test(codeText)) return;
    executedTurns.add(getToolTurnKey(block));
  });
  try {
    sessionStorage.setItem(EXECUTED_KEY, JSON.stringify([...executedTurns]));
  } catch (e) { /* storage quota */ }
}

/**
 * Look up a previously produced output for this exact block, even if the turn
 * key has since changed (our own [SANDBOX OUTPUT] reply inserts a new user
 * bubble, so the same block gets a new turn key on the next render).
 */
function findCachedOutput(blockKey) {
  const direct = executedOutputs.get(blockKey);
  if (typeof direct === 'string') return direct;
  const suffix = '|' + blockKey.split('|').pop();
  for (const [key, value] of executedOutputs) {
    if (key.endsWith(suffix) && typeof value === 'string') return value;
  }
  return undefined;
}

function markExecuted(turnKey, blockKey, output) {
  executedTurns.add(turnKey);
  if (blockKey) {
    executedOutputs.set(blockKey, output);
    // The hash part is stable even when the turn key changes (our own
    // [SANDBOX OUTPUT] reply adds a new user bubble and therefore a new key).
    executedBlocks.add(blockKey.split('|').pop());
  }

  if (executedTurns.size > 300) {
    [...executedTurns].slice(0, executedTurns.size - 300).forEach((oldKey) => executedTurns.delete(oldKey));
  }
  if (executedOutputs.size > 300) {
    [...executedOutputs.keys()].slice(0, executedOutputs.size - 300).forEach((oldKey) => executedOutputs.delete(oldKey));
  }
  if (executedBlocks.size > 300) {
    [...executedBlocks].slice(0, executedBlocks.size - 300).forEach((oldKey) => executedBlocks.delete(oldKey));
  }

  try {
    const turnsJson = JSON.stringify([...executedTurns]);
    const outJson = JSON.stringify([...executedOutputs].slice(-300));
    const blocksJson = JSON.stringify([...executedBlocks].slice(-300));
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(EXECUTED_KEY, turnsJson);
      sessionStorage.setItem(EXECUTED_OUTPUT_KEY, outJson);
      sessionStorage.setItem(EXECUTED_BLOCKS_KEY, blocksJson);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(EXECUTED_KEY, turnsJson);
      localStorage.setItem(EXECUTED_OUTPUT_KEY, outJson);
      localStorage.setItem(EXECUTED_BLOCKS_KEY, blocksJson);
    }
  } catch (e) { /* storage quota - dedupe still works in memory */ }
}

function extractSandboxOutput(text) {
  if (!text) return null;
  const re = /\[SANDBOX OUTPUT(?:\s*\([^)]+\))?\]:\s*\n?([\s\S]*?)(?:\n\n(?:Continue with your next tool call|Please proceed|Provide your final)|\s*$)/;
  const m = text.match(re);
  if (m) {
    return m[1].replace(/\n+$/, '');
  }
  const mErr = text.match(/\[SANDBOX ERROR\]:\s*([\s\S]*?)(?:\n\nPlease fix|\s*$)/);
  if (mErr) {
    return mErr[1].replace(/\n+$/, '');
  }
  return null;
}

function findHistoricalOutputFromDom(block, toolObj) {
  if (!block || typeof document === 'undefined') return null;
  const currentMsg = block.closest('.ds-message, div._9663006, [data-virtual-list-item-key]');
  if (!currentMsg) return null;

  let el = currentMsg.nextElementSibling;
  while (el) {
    const text = el.textContent || '';
    if (text.includes('[SANDBOX OUTPUT')) {
      const out = extractSandboxOutput(text);
      if (out !== null) return out;
    }
    if (text.includes('[USER ANSWER]:')) {
      const m = text.match(/\[USER ANSWER\]:\s*"([^"]+)"/);
      if (m) return `Выбран ответ: ${m[1]}`;
    }
    if (el.querySelector && el.querySelector('.ds-markdown') && el !== currentMsg) {
      break;
    }
    el = el.nextElementSibling;
  }

  const allBubbles = document.querySelectorAll('.ds-message, div._9663006, [data-virtual-list-item-key]');
  for (const b of allBubbles) {
    if (currentMsg.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const text = b.textContent || '';
      if (text.includes('[SANDBOX OUTPUT')) {
        const out = extractSandboxOutput(text);
        if (out !== null) return out;
      }
      if (text.includes('[USER ANSWER]:')) {
        const m = text.match(/\[USER ANSWER\]:\s*"([^"]+)"/);
        if (m) return `Выбран ответ: ${m[1]}`;
      }
      if (b.querySelector && b.querySelector('.ds-markdown') && b !== currentMsg) {
        break;
      }
    }
  }

  return null;
}
// </du-tool-dedupe>

let allowExecution = false;

// The page was loaded at this moment. A tool call may only run when the user
// sent a message AFTER the page was loaded - otherwise it is chat history.
const DU_PAGE_LOAD_TS = Date.now();

/**
 * The interceptor (MAIN world) sees every outgoing request and stamps
 * 'du_user_message_ts' there. The composer hook is not reliable - the send
 * button is not always inside the hooked element - so this is the fallback
 * that decides whether a tool call may run.
 */
function refreshAllowExecution() {
  try {
    const ts = Number(localStorage.getItem('du_user_message_ts') || 0);
    if (ts && ts > DU_PAGE_LOAD_TS) {
      allowExecution = true;
      return;
    }
    const activeSess = sessionStorage.getItem('du_active_agent_session');
    const activeTime = Number(sessionStorage.getItem('du_active_agent_time') || 0);
    const currSess = (location.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/) || [])[1] || 'root';
    if (activeSess && activeSess === currSess && Date.now() - activeTime < 3600000) {
      allowExecution = true;
    }
  } catch (e) {}
}

// Clipboard Sanitizer: only clean user prompt is copied
document.addEventListener('copy', (e) => {
  const selection = document.getSelection()?.toString() || '';
  if (selection.includes('[SYSTEM CAPABILITY:') || selection.includes('[SYSTEM INSTRUCTION:')) {
    const clean = selection.replace(/\[SYSTEM (?:CAPABILITY|INSTRUCTION):[\s\S]*?\[USER REQUEST\]:\s*/g, '');
    e.clipboardData.setData('text/plain', clean);
    e.preventDefault();
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[role="button"], button');
  if (!btn) return;

  const userRow = btn.closest('div._9663006') || btn.closest('.ds-message');
  if (userRow && userRow.querySelector('.fbb737a4')) {
    setTimeout(async () => {
      try {
        const clipText = await navigator.clipboard.readText();
        if (clipText && (clipText.includes('[SYSTEM CAPABILITY:') || clipText.includes('[SYSTEM INSTRUCTION:') || clipText.includes('[AVAILABLE SKILLS') || clipText.includes('[ATTACHED ASSETS'))) {
          const cleanText = clipText.replace(/\[(?:SYSTEM (?:CAPABILITY|INSTRUCTION)|AVAILABLE SKILLS|ATTACHED ASSETS)[\s\S]*?\[USER REQUEST\]:\s*/g, '');
          await navigator.clipboard.writeText(cleanText);
        }
      } catch (err) {}
    }, 50);
  }
}, true);

/**
 * DeepSeek sometimes ignores the ```json:tool fence and emits the call as raw
 * markup (<tool_call> or DSML). React re-renders the message while it streams,
 * which wipes inline styles, so the raw text would flash in the chat. This
 * pass runs on every DOM mutation and re-hides the whole call region.
 */
function hideRawToolCallMarkup() {
  document.querySelectorAll('.ds-markdown').forEach((msg) => {
    const text = msg.textContent || '';
    const isDsml = /DSML/i.test(text);
    const isTag = /<\s*\/?\s*tool_call/i.test(text);
    if (!isDsml && !isTag) return;

    const children = Array.from(msg.children);
    if (!children.length) return;

    // DSML calls open with <...DSML...calls> and close with </...DSML...calls>
    // Notice: closeRe MUST require the closing slash '/' so it never matches the opening tag.
    const openRe = isDsml ? /<\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+(?:tool_|function_)?calls/i : /<\s*tool_call/i;
    const closeRe = isDsml ? /<\s*\/\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+(?:tool_|function_)?calls\s*>/i : /<\s*\/\s*tool_call/i;

    let start = -1;
    let end = -1;
    children.forEach((child, index) => {
      const childText = child.textContent || '';
      if (start === -1 && (openRe.test(childText) || (isDsml && /DSML/i.test(childText)))) {
        start = index;
      }
      if (closeRe.test(childText)) {
        end = index;
      }
    });
    if (start === -1) return;
    if (end === -1 || end < start) end = children.length - 1;

    for (let i = start; i <= end; i++) {
      children[i].style.setProperty('display', 'none', 'important');
    }
  });
}

// Preemptively hide any streaming json:tool block before parser even finishes
function preemptiveHide() {
  const codeBlocks = document.querySelectorAll('.md-code-block, pre');
  codeBlocks.forEach(b => {
    const txt = b.innerText || '';
    if (txt.includes('json:tool') || (txt.includes('"tool"') && txt.includes('{'))) {
      if (b.style.display !== 'none' && !b.hasAttribute('data-du-widget-attached')) {
        b.style.setProperty('display', 'none', 'important');
      }
    }
  });
}

/**
 * The agent directive is prefixed to the prompt, so DeepSeek renders it inside
 * the user bubble as separate paragraphs (code fences included). The cleanup
 * above can only strip the directive when it sits in one text node, so the
 * leftover "[ATTACHED ASSETS AVAILABLE IN VFS]:" block stayed visible.
 *
 * Everything before the "[USER REQUEST]:" marker belongs to us: hide it and
 * keep only the user's own text. Also unclamp any collapsible container that
 * DeepSeek introduced because of the directive's length, so the user prompt
 * is never hidden or truncated behind an expand button.
 */
function hideInjectedDirectiveBlocks() {
  const bubbles = document.querySelectorAll('.fbb737a4, div[class*="message"], .ds-message');
  bubbles.forEach((bubble) => {
    const text = bubble.textContent || '';
    const hasDirective = text.includes('[USER REQUEST]:') || (
      text.includes('[SYSTEM CAPABILITY:')
      || text.includes('[SYSTEM INSTRUCTION:')
      || text.includes('[AVAILABLE SKILLS (Loaded in VFS)]:')
      || text.includes('[ATTACHED ASSETS AVAILABLE IN VFS]:')
    );
    if (!hasDirective) return;

    let target = bubble.querySelector('[data-du-user-request="1"]');
    if (!target) {
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const val = node.nodeValue || '';
        if (val.includes('[USER REQUEST') || val.includes('USER REQUEST]:') || val.includes('[USER REQUEST]:')) {
          target = node.parentElement;
          break;
        }
      }
      if (!target) return;
      target.setAttribute('data-du-user-request', '1');

      // Strip the marker itself, keep the user's text.
      const inner = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let innerNode;
      while ((innerNode = inner.nextNode())) {
        const val = innerNode.nodeValue || '';
        const m = val.match(/\[?USER REQUEST\]?:?\s*/);
        if (m) {
          innerNode.nodeValue = val.slice(0, m.index)
            + val.slice(m.index + m[0].length).replace(/^\s+/, '');
          break;
        }
      }
    }

    // Hide every sibling that precedes the user's text inside this bubble.
    let el = target;
    while (el && el !== bubble) {
      let sib = el.previousElementSibling;
      while (sib) {
        const prev = sib.previousElementSibling;
        sib.style.setProperty('display', 'none', 'important');
        sib = prev;
      }
      el = el.parentElement;
    }

    // If DeepSeek wrapped the long prompt in a collapsible text container,
    // unclamp it and hide the expand/collapse toggle button so the user's prompt
    // stays fully visible without an awkward "v" arrow or truncated 0px height.
    bubble.querySelectorAll('.ds-collapsible-text, [class*="collapsible"]').forEach((c) => {
      c.style.setProperty('max-height', 'none', 'important');
      c.style.setProperty('-webkit-line-clamp', 'unset', 'important');
      c.style.setProperty('height', 'auto', 'important');
      c.style.setProperty('overflow', 'visible', 'important');
    });
    bubble.querySelectorAll('button, [class*="collapse"], [class*="expand"], .ds-collapsible-text__action').forEach((btn) => {
      if (btn.querySelector('svg') || btn.textContent.includes('v') || btn.classList.contains('ds-collapsible-text__action')) {
        btn.style.setProperty('display', 'none', 'important');
      }
    });
  });
}

// Seamless unification & absolute stealth (Safe non-destructive mode)
function cleanAndUnifyChat() {
  preemptiveHide();
  hideRawToolCallMarkup();
  hideInjectedDirectiveBlocks();

  // 1. Clean user prompts inside main chat message text nodes
  const messageNodes = document.querySelectorAll('.ds-message, div[class*="message"], .ds-collapsible-text');
  messageNodes.forEach(container => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && (node.nodeValue.includes('[SYSTEM CAPABILITY:') || node.nodeValue.includes('[SYSTEM INSTRUCTION:') || node.nodeValue.includes('[AVAILABLE SKILLS') || node.nodeValue.includes('[ATTACHED ASSETS'))) {
        node.nodeValue = node.nodeValue.replace(/\[(?:SYSTEM (?:CAPABILITY|INSTRUCTION)|AVAILABLE SKILLS|ATTACHED ASSETS)[\s\S]*?\[USER REQUEST\]:\s*/g, '');
      }
    }
  });

  // 2. Clean Right-side Minimap / Navigation items
  const minimapItems = document.querySelectorAll('div._72b6158, div._81e7b5e, div.ds-virtual-list-visible-items > div');
  minimapItems.forEach(item => {
    const text = item.innerText || '';
    if (text.includes('[SANDBOX OUTPUT') || text.includes('[USER ANSWER]:')) {
      item.style.setProperty('display', 'none', 'important');
    } else if (text.includes('[SYSTEM CAPABILITY:') || text.includes('[SYSTEM INSTRUCTION:') || text.includes('[AVAILABLE SKILLS') || text.includes('[ATTACHED ASSETS')) {
      const targetTextNode = findTextNodeWith(item, '[');
      if (targetTextNode) {
        targetTextNode.nodeValue = targetTextNode.nodeValue.replace(/\[(?:SYSTEM (?:CAPABILITY|INSTRUCTION)|AVAILABLE SKILLS|ATTACHED ASSETS)[\s\S]*?\[USER REQUEST\]:\s*/g, '');
      }
    }
  });

  // 3. Hide silent sandbox output and user answers bubbles directly
  const chatBubbles = document.querySelectorAll('.ds-message, div._9663006');
  chatBubbles.forEach(bubble => {
    // Only target user bubbles containing the silent keywords, never hide the whole chat container
    const isUserMessage = bubble.querySelector('.fbb737a4') || bubble.classList.contains('fbb737a4');
    const text = bubble.innerText || '';
    if (isUserMessage && (text.includes('[SANDBOX OUTPUT') || text.includes('[USER ANSWER]:'))) {
      bubble.setAttribute('data-du-silent', 'true');
      const nextActionBar = bubble.nextElementSibling;
      if (nextActionBar && (nextActionBar.classList.contains('_11d6b3a') || nextActionBar.classList.contains('_0a3d93b'))) {
        nextActionBar.setAttribute('data-du-silent', 'true');
      }
    }
  });

  // Hide action bars on active running widgets
  const runningWidgets = document.querySelectorAll('.opencode-tool-root[data-running="true"]');
  runningWidgets.forEach(w => {
    const parent = w.closest('.ds-message') || w.closest('div._9663006');
    if (parent) {
      const act = parent.querySelector('div._0a3d93b, div._965abe9');
      if (act) act.style.setProperty('display', 'none', 'important');
    }
  });

  // 4. Render inline VFS media & file cards for model links like [name](/path) or ![name](/path)
  renderVfsArtifactLinks();
}

function renderVfsArtifactLinks() {
  const assistantLinks = document.querySelectorAll('div.ds-markdown a, .ds-message a');
  assistantLinks.forEach(async (a) => {
    if (a.hasAttribute('data-du-vfs-processed')) return;
    let href = a.getAttribute('href') || a.innerText || '';
    
    // Support relative paths, vfs:/, and also auto-created https://domain.ext/ links from raw markdown
    let cleanPath = '';
    if (href.startsWith('/') || href.startsWith('vfs:/') || href.startsWith('./')) {
      cleanPath = href.replace(/^vfs:/, '');
    } else if (href.includes('://')) {
      // e.g. https://ram_prices.svg/ or https://domain.com/path/chart.png
      const rawUrl = href.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const parts = rawUrl.split('/');
      const lastPart = parts[parts.length - 1] || parts[0];
      if (lastPart.includes('.')) {
        cleanPath = '/' + lastPart;
      }
    }

    if (!cleanPath || !cleanPath.includes('.')) return;

    // Normalize path to ensure leading slash
    if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

    a.setAttribute('data-du-vfs-processed', 'true');
    const fileRes = await fetchFileFromSandbox(cleanPath);
    if (!fileRes || !fileRes.success) {
      // Reset flag if file was not ready yet so it can be retried on next mutation
      a.removeAttribute('data-du-vfs-processed');
      return;
    }

    const filename = cleanPath.split('/').filter(Boolean).pop() || cleanPath;
    const isPic = isImageFile(filename);

    if (isPic) {
      // Large Rich Image View
      const card = document.createElement('div');
      card.className = 'du-vfs-image-card';
      const ext = filename.split('.').pop().toLowerCase();
      
      let isSvgDirect = false;
      let svgRawText = '';

      if (ext === 'svg') {
        try {
          const binaryStr = atob(fileRes.base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          svgRawText = new TextDecoder('utf-8').decode(bytes);
          if (svgRawText.includes('<svg')) {
            isSvgDirect = true;
          }
        } catch (e) {}
      }

      if (isSvgDirect) {
        // Embed SVG DOM node directly — 100% immune to data-URI / CSP / mime-type browser bugs
        card.innerHTML = `
          <div class="du-vfs-svg-container" style="padding: 12px; display: flex; justify-content: center; background: #0d0e10; max-height: 520px; overflow: hidden;">
            ${svgRawText}
          </div>
          <div class="du-vfs-caption">
            <span>${escapeHtml(filename)}</span>
            <span>${formatBytes(fileRes.size)}</span>
          </div>
        `;
        const svgEl = card.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
          svgEl.style.display = 'block';
        }
      } else {
        const imgSrc = `data:image/${ext};base64,${fileRes.base64}`;
        card.innerHTML = `
          <img class="du-vfs-image-preview" src="${imgSrc}" alt="${escapeHtml(filename)}" title="Нажмите для увеличения" />
          <div class="du-vfs-caption">
            <span>${escapeHtml(filename)}</span>
            <span>${formatBytes(fileRes.size)}</span>
          </div>
        `;
        const img = card.querySelector('.du-vfs-image-preview');
        if (img) img.onclick = () => { img.classList.toggle('du-zoomed'); };
      }

      // Replace link with full image card
      a.parentNode.replaceChild(card, a);
    } else {
      // Interactive File Card
      const card = document.createElement('div');
      card.className = 'du-vfs-file-card';
      const ext = (filename.split('.').pop() || 'FILE').toUpperCase();

      card.innerHTML = `
        <div class="du-vfs-file-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="du-vfs-file-info">
          <span class="du-vfs-file-name" title="${escapeHtml(cleanPath)}">${escapeHtml(filename)}</span>
          <span class="du-vfs-file-meta">${ext} • ${formatBytes(fileRes.size)}</span>
        </div>
        <button class="du-vfs-download-btn" title="Скачать файл" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
      `;

      const downloadBtn = card.querySelector('.du-vfs-download-btn');
      downloadBtn.onclick = (e) => {
        e.stopPropagation();
        const byteCharacters = atob(fileRes.base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const dlLink = document.createElement('a');
        dlLink.href = url;
        dlLink.download = filename;
        document.body.appendChild(dlLink);
        dlLink.click();
        document.body.removeChild(dlLink);
        URL.revokeObjectURL(url);
      };

      a.parentNode.replaceChild(card, a);
    }
  });
}

function findTextNodeWith(element, pattern) {
  if (!element) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.includes(pattern)) {
      return node;
    }
  }
  return null;
}

// <du-send-path>
function findDeepSeekInput() {
  const allNodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]'));
  if (allNodes.length === 0) return null;

  const nodes = allNodes.filter((el) => {
    if (el.matches && el.matches('.du-textarea, .du-input, [class*="du-"]')) return false;
    if (el.closest && el.closest('[role="dialog"], .ds-modal, .du-native-skills-panel, .du-native-files-panel, .du-native-config-panel')) return false;
    return true;
  });
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];

  const visible = nodes.filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
  });
  if (visible.length === 0) return nodes[0];

  // The chat composer is the largest visible input. A sidebar search box is
  // small, so this reliably picks the real composer when both exist.
  visible.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const areaDelta = (rb.width * rb.height) - (ra.width * ra.height);
    if (Math.abs(areaDelta) > 100) return areaDelta;
    return rb.top - ra.top;
  });
  return visible[0];
}

function readInputValue(inputEl) {
  if (!inputEl) return '';
  return (inputEl.value !== undefined ? inputEl.value : inputEl.textContent || '');
}

function updateReactInput(inputEl, text) {
  if (!inputEl) return false;
  inputEl.focus();

  if (inputEl.tagName && inputEl.tagName.toLowerCase() === 'textarea') {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                         Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = text;
    }
    // React tracks the last value it rendered. Dispatching `input` through the
    // native setter makes its onChange fire and commit the new state.
    inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } else {
    inputEl.textContent = text;
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  }
  return true;
}

// Resilient, semantic detection of send button without depending on obfuscated class names
function findSendButton(inputEl = findDeepSeekInput()) {
  const formOrArea = inputEl?.closest('form, div:has(textarea), div:has([contenteditable])') || document.body;

  // 1. Try finding by accessibility role/label
  const ariaCandidates = formOrArea.querySelectorAll(
    'button[type="submit"], [role="button"][aria-label*="Send"], [role="button"][aria-label*="Отправить"], button[aria-label*="Send"], button[aria-label*="Отправить"]'
  );
  for (const el of ariaCandidates) {
    if (isButtonInteractable(el)) return el;
  }

  // 2. Try finding by standard DeepSeek button structure
  const primaryButtons = formOrArea.querySelectorAll(
    '.ds-button--primary, button:not([disabled]), div[role="button"]:not([aria-disabled="true"])'
  );
  for (const btn of primaryButtons) {
    if (isButtonInteractable(btn)) {
      // Check if button has send/arrow SVG or is aligned near input bottom-right
      const hasSvg = btn.querySelector('svg');
      if (hasSvg) {
        // Exclude attachment, audio, or toggle buttons
        if (!btn.classList.contains('du-agent-toggle-btn') && !btn.querySelector('input[type="file"]')) {
          return btn;
        }
      }
    }
  }

  // 3. Fallback: Any button with arrow-up / paper-plane path
  const svgButtons = formOrArea.querySelectorAll('div[role="button"], button');
  for (const btn of svgButtons) {
    if (btn.classList.contains('du-agent-toggle-btn')) continue;
    const path = btn.querySelector('svg path');
    if (path && isButtonInteractable(btn)) {
      return btn;
    }
  }

  return null;
}

function isButtonInteractable(el) {
  if (!el) return false;
  if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') || el.classList.contains('ds-button--disabled')) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
}

function triggerSend(inputEl = findDeepSeekInput()) {
  const sendBtn = findSendButton(inputEl);

  // Method 1: Synthesize trusted-like mouse events sequence on send button
  if (sendBtn) {
    const rect = sendBtn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
      const evt = new MouseEvent(evtType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y
      });
      sendBtn.dispatchEvent(evt);
    });
    return 'click';
  }

  // Method 2: Fallback keyboard sequence with full Enter signatures (Enter keycode 13)
  if (inputEl) {
    const keyEventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true,
      view: window
    };
    inputEl.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
    return 'enter';
  }

  return 'none';
}

// Hybrid Transport: DOM vs Direct Network API (Configurable in popup, default false for stability)
let useDirectNetworkApi = JSON.parse(localStorage.getItem('du_use_network_api') ?? 'false');

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((req) => {
    if (req && req.action === 'set_use_network_api') {
      useDirectNetworkApi = !!req.value;
      localStorage.setItem('du_use_network_api', JSON.stringify(useDirectNetworkApi));
      console.log('[DeepUpgrade] Direct Network API Transport set to:', useDirectNetworkApi);
    }
  });
}

/* -------------------------------------------------------------------------
 * Silent-send diagnostics
 * -------------------------------------------------------------------------
 * Every silent dispatch records what it intended to send, what the composer
 * actually contained, how many clicks/Enters it made, and — most importantly —
 * what prompt the MAIN world interceptor actually saw going to the network.
 * Read the log from the page console:
 *     __duSendLog()        // full JSON
 *     __duSendLogTable()   // compact table
 * It is persisted in sessionStorage under `du_send_log` (last 120 entries),
 * so it survives a chat re-render and can be copied after a failure.
 * ----------------------------------------------------------------------- */
const SEND_LOG_KEY = 'du_send_log';
const SEND_LOG_LIMIT = 120;

function normalizeForMatch(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function duSendLog(phase, data) {
  const entry = Object.assign({ ts: new Date().toISOString(), phase }, data || {});
  try {
    const log = JSON.parse(sessionStorage.getItem(SEND_LOG_KEY) || '[]');
    log.push(entry);
    while (log.length > SEND_LOG_LIMIT) log.shift();
    sessionStorage.setItem(SEND_LOG_KEY, JSON.stringify(log));
  } catch (e) { /* storage disabled or full — console log below still works */ }
  if (phase !== 'attempt' && phase !== 'value-set') {
    console.log('[DeepUpgrade send]', phase, entry);
  }
  return entry;
}

window.__duSendLog = function () {
  try { return JSON.parse(sessionStorage.getItem(SEND_LOG_KEY) || '[]'); }
  catch (e) { return []; }
};

window.__duSendLogTable = function () {
  const log = window.__duSendLog();
  if (console.table) {
    console.table(log.map((e) => ({
      time: e.ts,
      phase: e.phase,
      job: e.job || '',
      len: e.len ?? e.outLen ?? '',
      ms: e.ms ?? '',
      note: e.note || e.error || e.preview || ''
    })));
  }
  return log;
};

window.__duSendState = function () {
  return {
    activeJob: duActiveSendJob ? {
      id: duActiveSendJob.id,
      attempts: duActiveSendJob.attempts,
      emptySends: duActiveSendJob.emptySends,
      done: duActiveSendJob.done
    } : null,
    lastOutgoingPrompt: duLastOutgoingPrompt
  };
};

// Truth source: the MAIN-world interceptor posts the exact prompt that is
// leaving the page. This is how we distinguish "text was never placed in the
// composer" from "the composer submitted before React committed the value".
let duActiveSendJob = null;
let duLastOutgoingPrompt = null;

function duFinishSendJob(job, outcome) {
  if (!job || job.done) return;
  job.done = true;
  job.outcome = outcome;
  if (job.watchdog) clearTimeout(job.watchdog);
  duSendLog('finished', {
    job: job.id,
    outcome,
    ms: Date.now() - job.startedAt,
    attempts: job.attempts,
    emptySends: job.emptySends,
    mismatches: job.mismatches
  });
  if (job.inputEl) job.inputEl.classList.remove('du-freezing');
  if (job.container) job.container.classList.remove('du-locked-box');
  if (duActiveSendJob === job) duActiveSendJob = null;
  if (typeof job.resolve === 'function') job.resolve(outcome);
}

function duCheckOutgoingPrompt(job, msg) {
  if (!job || job.done) return;
  const got = normalizeForMatch(msg.prompt);
  const expected = job.expected;

  if (!got) {
    job.emptySends++;
    duSendLog('outgoing-EMPTY', {
      job: job.id,
      transport: msg.transport || '',
      expectedLen: expected.length,
      note: 'composer submitted without text — scheduling recovery'
    });
    job.needsResend = true;
    job.resendDelay = Math.min((job.resendDelay || 300) * 2, 4800);
    job.resendNotBefore = Date.now() + job.resendDelay;
    return;
  }

  if (got === expected || (job.snippet && got.includes(job.snippet))) {
    job.delivered = true;
    duSendLog('outgoing-ok', {
      job: job.id,
      transport: msg.transport || '',
      outLen: got.length,
      ms: Date.now() - job.startedAt
    });
    duFinishSendJob(job, 'delivered');
    return;
  }

  job.mismatches++;
  duSendLog('outgoing-mismatch', {
    job: job.id,
    transport: msg.transport || '',
    outLen: got.length,
    expectedLen: expected.length,
    preview: got.slice(0, 80),
    note: 'logged only - may be an unrelated request'
  });
}

window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || data.type !== 'DU_OUTGOING_PROMPT') return;
  duLastOutgoingPrompt = data;
  duSendLog('outgoing-captured', {
    job: duActiveSendJob ? duActiveSendJob.id : '',
    transport: data.transport || '',
    len: typeof data.prompt === 'string' ? data.prompt.length : -1,
    empty: !normalizeForMatch(data.prompt),
    preview: normalizeForMatch(data.prompt).slice(0, 60)
  });
  if (duActiveSendJob) duCheckOutgoingPrompt(duActiveSendJob, data);
});

/** Returns true only when the composer visibly holds the full reply. */
function setInputValueVerified(inputEl, text, job) {
  const expected = normalizeForMatch(text);
  for (let i = 1; i <= 5; i++) {
    updateReactInput(inputEl, text);
    const actual = normalizeForMatch(readInputValue(inputEl));
    if (actual === expected) {
      if (job) duSendLog('value-set', { job: job.id, attempt: i, len: actual.length });
      return true;
    }
    if (job) duSendLog('value-set-mismatch', {
      job: job.id,
      attempt: i,
      expectedLen: expected.length,
      actualLen: actual.length
    });
  }
  return false;
}

function lastUserMessageText() {
  let bubbles = document.querySelectorAll('.fbb737a4');
  if (bubbles.length === 0) {
    bubbles = document.querySelectorAll('.ds-message:not(:has(.ds-markdown)), [data-virtual-list-item-key]:not(:has(.ds-markdown))');
  }
  if (bubbles.length === 0) return '';
  const last = bubbles[bubbles.length - 1];
  return normalizeForMatch(last.innerText || last.textContent || '');
}

function nodeIsUsable(el) {
  return !!(el && el.isConnected && document.contains(el));
}

async function dispatchSilentReply(text) {
  const raw = typeof text === 'string' ? text : (text == null ? '' : String(text));
  const expected = normalizeForMatch(raw);

  const job = {
    id: 'send_' + Math.random().toString(36).slice(2, 8),
    expected,
    snippet: expected.slice(0, 40),
    startedAt: Date.now(),
    done: false,
    delivered: false,
    attempts: 0,
    emptySends: 0,
    mismatches: 0,
    needsResend: false,
    inputEl: null,
    container: null,
    resolve: null
  };

  // Guard: an empty reply must never be dispatched as an empty message.
  if (!expected) {
    duSendLog('abort-empty-reply', { job: job.id, len: raw.length });
    console.warn('[DeepUpgrade] sendSilentReply("") ignored — nothing to send.');
    return false;
  }

  duSendLog('requested', {
    job: job.id,
    len: raw.length,
    prefix: expected.slice(0, 24),
    transport: useDirectNetworkApi ? 'network' : 'dom'
  });

  // Watchdog: no matter which transport path is taken, a job must always
  // settle. A job that hangs here used to block the serialized send chain
  // forever, so every later [SANDBOX OUTPUT] was queued and never sent.
  job.watchdog = setTimeout(() => {
    if (job.done) return;
    duSendLog('abort-watchdog', { job: job.id, ms: Date.now() - job.startedAt });
    duFinishSendJob(job, 'watchdog');
  }, 25000);

  // Option 1: Direct Network API (Zero-touch background dispatch via window postMessage bridge)
  if (useDirectNetworkApi) {
    try {
      console.log('%c[DeepUpgrade] 🚀 Отправка ответа через Direct Network API...', 'color: #10b981; font-weight: bold;');
      
      const networkResult = await new Promise((resolve) => {
        const reqId = 'du_net_' + Math.random().toString(36).slice(2);
        const onMsg = (e) => {
          if (e.data && e.data.type === 'DU_NETWORK_SEND_RESULT' && e.data.reqId === reqId) {
            window.removeEventListener('message', onMsg);
            resolve(e.data);
          }
        };
        window.addEventListener('message', onMsg);

        // Send request to interceptor in MAIN world
        window.postMessage({
          type: 'DU_NETWORK_SEND_MESSAGE',
          reqId,
          text: raw
        }, '*');

        // Fallback timer if MAIN world doesn't answer in 10s
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve({ success: false, error: 'Network bridge timeout' });
        }, 10000);
      });

      if (networkResult.success) {
        duSendLog('network-ok', { job: job.id, len: raw.length });
        console.log('%c[DeepUpgrade] ✅ Запрос инструмента успешно отправлен в Network API!', 'color: #4ade80;');
        return true;
      } else {
        duSendLog('network-failed', { job: job.id, error: String(networkResult.error || 'unknown') });
        console.warn('[DeepUpgrade] Network API bridge вернул ошибку, переход на DOM:', networkResult.error);
      }
    } catch(err) {
      duSendLog('network-error', { job: job.id, error: String(err && err.message || err) });
      console.warn('[DeepUpgrade] Ошибка Network API, fallback на DOM эмуляцию:', err);
    }
  }

  // Option 2 (Fallback): DOM Emulation
  const inputEl = findDeepSeekInput();
  if (!inputEl) {
    duSendLog('abort-no-input', { job: job.id });
    return false;
  }

  const container = inputEl.closest('form, div:has(textarea), div:has([contenteditable])') || inputEl.parentElement;
  job.inputEl = inputEl;
  job.container = container;
  duActiveSendJob = job;

  if (container) container.classList.add('du-locked-box');
  inputEl.classList.add('du-freezing');

  if (!setInputValueVerified(inputEl, raw, job)) {
    duSendLog('abort-value-not-set', {
      job: job.id,
      actualLen: normalizeForMatch(readInputValue(inputEl)).length
    });
    duFinishSendJob(job, 'value-not-set');
    return false;
  }

  const valueSetAt = Date.now();
  const maxAttempts = 25;
  let target = inputEl;
  let clearedAt = 0;
  let lastValueSetAt = valueSetAt;
  const hardDeadline = valueSetAt + 20000;

  const attempt = () => {
    if (job.done) return;
    try {
      attemptStep();
    } catch (err) {
      duSendLog('abort-error', { job: job.id, error: String((err && err.message) || err) });
      console.warn('[DeepUpgrade] send attempt failed:', err);
      duFinishSendJob(job, 'error');
    }
  };

  const attemptStep = () => {
    if (job.done) return;

    if (Date.now() > hardDeadline) {
      duSendLog('abort-deadline', {
        job: job.id,
        leftLen: normalizeForMatch(readInputValue(target)).length,
        emptySends: job.emptySends,
        mismatches: job.mismatches
      });
      if (nodeIsUsable(target) && normalizeForMatch(readInputValue(target)).length > 0) {
        updateReactInput(target, '');
      }
      duFinishSendJob(job, 'deadline');
      return;
    }

    // The composer can be re-rendered by React at any moment. Sending through a
    // detached node is exactly how an "empty message" is produced, so re-find it.
    if (!nodeIsUsable(target)) {
      duSendLog('input-detached', { job: job.id, attempt: job.attempts });
      target = findDeepSeekInput();
      job.inputEl = target;
      if (!target) {
        duSendLog('abort-input-vanished', { job: job.id });
        duFinishSendJob(job, 'input-vanished');
        return;
      }
      if (!setInputValueVerified(target, raw, job)) {
        duSendLog('abort-value-not-set', {
          job: job.id,
          actualLen: normalizeForMatch(readInputValue(target)).length
        });
        duFinishSendJob(job, 'value-not-set');
        return;
      }
      lastValueSetAt = Date.now();
    }

    const current = normalizeForMatch(readInputValue(target));

    if (job.delivered) {
      duFinishSendJob(job, 'delivered');
      return;
    }

    // On a failed attempt React may restore the committed value on its next
    // render, so wait before touching the composer again.
    if (job.resendNotBefore && Date.now() < job.resendNotBefore) {
      setTimeout(attempt, 100);
      return;
    }

    if (job.needsResend) {
      job.needsResend = false;
      if (current.length === 0) {
        duSendLog('recover-restoring', { job: job.id, attempt: job.attempts });
        if (!setInputValueVerified(target, raw, job)) {
          duSendLog('abort-value-not-set', { job: job.id, actualLen: normalizeForMatch(readInputValue(target)).length });
          duFinishSendJob(job, 'value-not-set');
          return;
        }
        lastValueSetAt = Date.now();
      } else {
        // The composer already holds the reply again — just click it.
        duSendLog('recover-resending', { job: job.id, attempt: job.attempts, inputLen: current.length });
      }
      clearedAt = 0;
    } else if (current.length === 0) {
      // React consumed the composer but the interceptor has not reported yet.
      // Give the network hook time before concluding anything.
      if (!clearedAt) clearedAt = Date.now();
      const waited = Date.now() - clearedAt;
      if (waited < 1500) {
        setTimeout(attempt, 100);
        return;
      }
      // No network capture at all (unknown transport) — fall back to the DOM.
      const last = lastUserMessageText();
      if (job.snippet && last.includes(job.snippet)) {
        duSendLog('bubble-confirmed', { job: job.id, ms: Date.now() - job.startedAt });
        job.delivered = true;
        duFinishSendJob(job, 'delivered-bubble');
        return;
      }
      duSendLog('input-cleared-unconfirmed', { job: job.id, note: 'no outgoing prompt captured and no bubble found; resending' });
      job.needsResend = true;
      job.resendDelay = Math.min((job.resendDelay || 300) * 2, 4800);
      job.resendNotBefore = Date.now() + job.resendDelay;
      clearedAt = 0;
      setTimeout(attempt, 60);
      return;
    }

    // Wait for React to commit the value before clicking. Clicking too early is
    // what submits an empty prompt: the button is still in its empty state.
    if (job.resendNotBefore && Date.now() < job.resendNotBefore) {
      setTimeout(attempt, 100);
      return;
    }
    if (Date.now() - lastValueSetAt < 200) {
      setTimeout(attempt, 80);
      return;
    }

    // Do not click a disabled send button: DeepSeek disables it while its React
    // state is empty, and pressing Enter at that moment submits an empty prompt.
    const sendBtn = findSendButton(target);
    if (!sendBtn) {
      const waited = Date.now() - lastValueSetAt;
      if (waited < 1200) {
        duSendLog('wait-send-button', { job: job.id, waited, inputLen: current.length });
        setTimeout(attempt, 100);
        return;
      }
      duSendLog('send-button-missing', { job: job.id, note: 'falling back to Enter after grace period' });
    }

    job.attempts++;
    const mode = triggerSend(target);
    duSendLog('attempt', {
      job: job.id,
      n: job.attempts,
      mode,
      inputLen: normalizeForMatch(readInputValue(target)).length
    });

    if (job.done) return;

    if (job.attempts >= maxAttempts) {
      duSendLog('abort-max-attempts', {
        job: job.id,
        leftLen: normalizeForMatch(readInputValue(target)).length,
        emptySends: job.emptySends,
        mismatches: job.mismatches
      });
      if (normalizeForMatch(readInputValue(target)).length > 0) {
        updateReactInput(target, '');
      }
      duFinishSendJob(job, 'timeout');
      return;
    }

    setTimeout(attempt, 150);
  };

  return new Promise((resolve) => {
    job.resolve = resolve;
    setTimeout(attempt, 120);
  });
}

// Silent replies are serialized: two overlapping dispatches would fight over
// the same composer and could submit an empty prompt.
let duSendChain = Promise.resolve();
let duSendChainBusy = false;
let duSendChainStartedAt = 0;

function sendSilentReply(text) {
  const len = typeof text === 'string' ? text.length : 0;
  duSendLog('queued', { len, busy: duSendChainBusy });

  // A stuck job must never swallow the rest of the conversation.
  if (duSendChainBusy && Date.now() - duSendChainStartedAt > 30000) {
    duSendLog('chain-reset', { stuckMs: Date.now() - duSendChainStartedAt });
    console.warn('[DeepUpgrade] send chain looked stuck, starting a fresh one.');
    duSendChain = Promise.resolve();
    duSendChainBusy = false;
  }

  const run = duSendChain.then(() => {
    duSendChainBusy = true;
    duSendChainStartedAt = Date.now();
    return dispatchSilentReply(text);
  });

  duSendChain = run.catch(() => {}).then(() => { duSendChainBusy = false; });
  return run;
}
// </du-send-path>

// Agent Toggle State (Persisted in localStorage)
let isAgentEnabled = (typeof window.__DU_SETTINGS__ !== 'undefined')
  ? window.__DU_SETTINGS__.isEnabled()
  : true;

// The popup, the in-page Agent button and the MAIN-world interceptor all read
// the same flag. Keep the in-page button in sync when it changes elsewhere.
function syncAgentToggleButton() {
  const btn = document.querySelector('.du-agent-toggle-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', isAgentEnabled ? 'true' : 'false');
  if (isAgentEnabled) {
    btn.classList.add('ds-toggle-button--selected');
  } else {
    btn.classList.remove('ds-toggle-button--selected');
  }
}

if (typeof window.__DU_SETTINGS__ !== 'undefined') {
  window.__DU_SETTINGS__.onChanged((value) => {
    isAgentEnabled = !!value;
    syncAgentToggleButton();
  });
  // Pull the durable value (a switch flipped in another tab) into the page.
  window.__DU_SETTINGS__.read((value) => {
    if (value === null || value === undefined) return;
    isAgentEnabled = !!value;
    syncAgentToggleButton();
  });
}

let duLastComposerValue = '';

/**
 * Detect "the message was sent" by watching the composer.
 *
 * The send button is not always inside the element the send hook listens to,
 * so the hook alone missed a lot of sends and every tool call was rejected as
 * chat history. DeepSeek clears the composer when the message goes out, which
 * is a signal that works for every way of sending.
 */
function watchComposerSend() {
  try {
    const inputEl = findDeepSeekInput();
    if (!inputEl) return;
    const value = readInputValue(inputEl);
    if (duLastComposerValue.trim() && !value.trim()) {
      allowExecution = true;
      publishDirectiveToMainWorld(true);
    }
    duLastComposerValue = value;
  } catch (e) {}
}

function hookInput() {
  const inputEl = findDeepSeekInput();
  if (!inputEl || inputEl.hasAttribute('data-du-hooked')) return;

  inputEl.setAttribute('data-du-hooked', 'true');

  const onSend = () => {
    const val = (inputEl.value !== undefined ? inputEl.value : inputEl.textContent || '').trim();
    if (!val || val.includes('[SYSTEM CAPABILITY:') || val.includes('[SYSTEM INSTRUCTION:') || val.startsWith('[SANDBOX OUTPUT')) return;

    if (isAgentEnabled) {
      allowExecution = true;
      try {
        const sessId = (location.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/) || [])[1] || 'root';
        sessionStorage.setItem('du_active_agent_session', sessId);
        sessionStorage.setItem('du_active_agent_time', String(Date.now()));
      } catch (e) {}

      // Publish the full directive (system, skills, assets) to localStorage
      // so interceptor.js (running in the MAIN world) attaches it cleanly
      // at the network layer (fetch and XHR). The composer textarea is NEVER
      // mangled with the 100-line directive, so the user's chat bubble stays
      // clean with only their own text, never collapses, and is never hidden.
      publishDirectiveToMainWorld(true);
      stagedAttachments.clear();
    } else {
      allowExecution = false;
      try {
        sessionStorage.removeItem('du_active_agent_session');
        sessionStorage.removeItem('du_active_agent_time');
      } catch (e) {}
      stagedAttachments.clear();
      // Plain normal message without any agent directives
    }

    watchComposerSend();
  };

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      onSend();
    }
  }, { capture: true });

  // Hook Send Button Click as well!
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, [role="button"]');
    if (!btn || btn.classList.contains('du-agent-toggle-btn')) return;

    const inputContext = findDeepSeekInput();
    const formOrContainer = inputContext?.closest('form, div:has(textarea), div:has([contenteditable])');
    if (formOrContainer && formOrContainer.contains(btn)) {
      onSend();
    }
  }, { capture: true });
}

const KNOWN_TOOL_NAMES = new Set([
  'write', 'edit', 'read', 'glob', 'grep', 'bash', 'python', 'py', 'js',
  'question', 'ask', 'todowrite', 'todo', 'install_skill', 'add_skill'
]);

// Initial load of JS plugins
if (typeof reloadAllPlugins === 'function') {
  reloadAllPlugins();
}

/**
 * Extract every balanced `{...}` block from a model response.
 * Unlike a greedy regex, this survives multiple JSON objects and nested braces.
 */
function extractBalancedJsonObjects(text) {
  const objects = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('{', index);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) break;
    const candidate = text.slice(start, end + 1);
    let foundTool = false;
    if (candidate.includes('"tool"')) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          objects.push(parsed);
          foundTool = true;
        }
      } catch (e) { /* malformed JSON is handled by the fallback parser */ }
    }
    // If this object was not the tool payload, keep scanning inside it.
    index = foundTool ? end + 1 : start + 1;
  }
  return objects;
}

/**
 * Read a JSON string field even when the surrounding JSON is malformed
 * (raw newlines, unescaped quotes, different field order).
 */
function extractJsonStringField(text, field) {
  const re = new RegExp('"' + field + '"\\s*:\\s*"', 'g');
  const match = re.exec(text);
  if (!match) return null;

  let raw = '';
  let escaped = false;
  for (let i = re.lastIndex; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      raw += '\\' + ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      try { return JSON.parse('"' + raw + '"'); } catch (e) { break; }
    }
    raw += ch;
  }
  return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Decode a JSON string body the way the model most likely meant it.
 * Valid JSON is parsed normally; otherwise only standard escapes are decoded,
 * so unescaped quotes in Python/JS code survive instead of truncating it.
 */
function decodeJsonStringLike(raw) {
  try {
    return JSON.parse('"' + raw + '"');
  } catch (e) { /* unescaped quotes or raw newlines */ }

  return raw.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (match, esc) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc;
    }
  });
}

/**
 * Like extractJsonStringField, but for the common malformed model output where
 * the field value itself contains unescaped quotes. When the field is the last
 * key of the object, take everything up to the closing quote before the final
 * brace and decode it. Otherwise fall back to the plain scan.
 */
function extractJsonStringFieldRobust(text, field) {
  const startRe = new RegExp('"' + field + '"\\s*:\\s*"');
  const match = startRe.exec(text);
  if (!match) return null;

  // Non-global regexes do not update lastIndex; compute the value start manually.
  const valueStart = match.index + match[0].length;
  const objEnd = text.lastIndexOf('}');
  if (objEnd > valueStart) {
    const tail = text.slice(valueStart, objEnd);
    const closeQuote = tail.lastIndexOf('"');
    if (closeQuote !== -1) {
      const after = tail.slice(closeQuote + 1).trim();
      // Only trust this when no other JSON key follows the value.
      if (after === '' || after === ',') {
        return decodeJsonStringLike(tail.slice(0, closeQuote));
      }
    }
  }

  return extractJsonStringField(text, field);
}

/** Validate required fields so a broken block can never write an empty file. */
function validateToolObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const tool = obj.tool;
  const asString = (value) => {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return null;
    return String(value);
  };

  if (tool === 'write') {
    const content = asString(obj.content) ?? asString(obj.text) ?? asString(obj.code);
    obj.content = content === null ? '' : content;
    if (!obj.path) {
      obj.__parseError = 'write: missing "path"';
    } else if (obj.content.length === 0) {
      obj.__parseError = 'write: "content" is empty — the tool block was not parsed correctly';
    }
  } else if (tool === 'edit') {
    const oldStr = asString(obj.old_str) ?? asString(obj.oldStr);
    const newStr = asString(obj.new_str) ?? asString(obj.newStr);
    if (!obj.path) obj.__parseError = 'edit: missing "path"';
    else if (oldStr === null || newStr === null) obj.__parseError = 'edit: missing "old_str" or "new_str"';
    else { obj.old_str = oldStr; obj.new_str = newStr; }
  } else if (tool === 'read') {
    if (!obj.path) obj.__parseError = 'read: missing "path"';
  } else if (tool === 'glob') {
    if (!obj.pattern) obj.__parseError = 'glob: missing "pattern"';
  } else if (tool === 'grep') {
    if (!obj.pattern) obj.__parseError = 'grep: missing "pattern"';
  } else if (tool === 'question' || tool === 'ask') {
    if (!obj.question && obj.prompt) obj.question = obj.prompt;
    if (!obj.question) obj.__parseError = 'question: missing "question"';
  } else if (tool === 'bash' || tool === 'python' || tool === 'py' || tool === 'js') {
    const code = asString(obj.code) ?? asString(obj.text);
    obj.code = code === null ? '' : code;
    if (obj.code.trim() === '') {
      obj.__parseError = tool + ': "code" is empty — the tool block was not parsed correctly';
    }
  }
  return obj;
}

function extractToolCallFallback(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool) {
        if (parsed.code || (parsed.tool === 'edit' && parsed.path) || (parsed.tool === 'install_skill' || parsed.tool === 'add_skill') || parsed.tool === 'read' || parsed.tool === 'write' || parsed.tool === 'glob' || parsed.tool === 'grep' || parsed.tool === 'question' || parsed.tool === 'ask' || parsed.tool === 'todowrite' || parsed.tool === 'todo') return parsed;
      }
    }
  } catch(e) {}

  const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
  if (!toolMatch) return null;
  const toolName = toolMatch[1];

  if (toolName === 'question' || toolName === 'ask') {
    const qMatch = text.match(/"question"\s*:\s*"([\s\S]*?)"\s*[,}]/) || text.match(/"prompt"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    const optionsMatch = text.match(/"options"\s*:\s*\[([\s\S]*?)\]/);
    let optionsList = [];
    if (optionsMatch) {
      optionsList = optionsMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').replace(/\\"/g, '"')).filter(Boolean);
    }
    return {
      tool: 'question',
      question: qMatch ? qMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : 'Требуется ваше решение:',
      options: optionsList.length > 0 ? optionsList : ['Да, продолжить', 'Отмена']
    };
  }

  if (toolName === 'glob') {
    const patternMatch = text.match(/"pattern"\s*:\s*"([^"]+)"/) || text.match(/"glob"\s*:\s*"([^"]+)"/);
    const pathMatch = text.match(/"path"\s*:\s*"([^"]+)"/);
    return {
      tool: 'glob',
      pattern: patternMatch ? patternMatch[1] : '*',
      path: pathMatch ? pathMatch[1] : '/'
    };
  }

  if (toolName === 'grep') {
    const patternMatch = text.match(/"pattern"\s*:\s*"([^"]+)"/) || text.match(/"query"\s*:\s*"([^"]+)"/);
    const pathMatch = text.match(/"path"\s*:\s*"([^"]+)"/);
    const includeMatch = text.match(/"include"\s*:\s*"([^"]+)"/) || text.match(/"glob"\s*:\s*"([^"]+)"/);
    if (patternMatch) {
      return {
        tool: 'grep',
        pattern: patternMatch[1],
        path: pathMatch ? pathMatch[1] : '/',
        include: includeMatch ? includeMatch[1] : ''
      };
    }
  }

  if (toolName === 'install_skill' || toolName === 'add_skill') {
    const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
    const urlMatch = text.match(/"url"\s*:\s*"([^"]+)"/);
    const promptMatch = text.match(/"prompt"\s*:\s*"([\s\S]*?)"\s*[,\}]/);
    const descMatch = text.match(/"desc"\s*:\s*"([^"]+)"/);
    return {
      tool: 'install_skill',
      name: nameMatch ? nameMatch[1] : 'Custom Skill',
      url: urlMatch ? urlMatch[1] : '',
      prompt: promptMatch ? promptMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '',
      desc: descMatch ? descMatch[1] : ''
    };
  }

  if (toolName === 'read') {
    const pathMatch = text.match(/"path"\s*:\s*"([^"]+)"/) || text.match(/"file"\s*:\s*"([^"]+)"/);
    const offsetMatch = text.match(/"offset"\s*:\s*(\d+)/);
    const limitMatch = text.match(/"limit"\s*:\s*(\d+)/);
    if (pathMatch) {
      return {
        tool: 'read',
        path: pathMatch[1],
        offset: offsetMatch ? parseInt(offsetMatch[1], 10) : 1,
        limit: limitMatch ? parseInt(limitMatch[1], 10) : 2000
      };
    }
  }

  if (toolName === 'write') {
    const pathMatch = text.match(/"path"\s*:\s*"([^"]+)"/) || text.match(/"file"\s*:\s*"([^"]+)"/);
    if (pathMatch) {
      let rawContent = extractJsonStringFieldRobust(text, 'content');
      if (rawContent === null) rawContent = extractJsonStringFieldRobust(text, 'text');
      if (rawContent === null) rawContent = extractJsonStringFieldRobust(text, 'code');
      return {
        tool: 'write',
        path: pathMatch[1],
        content: rawContent !== null ? rawContent : ''
      };
    }
  }

  if (toolName === 'edit') {
    // If strict JSON.parse worked, it was already handled above.
    const pathMatch = text.match(/"path"\s*:\s*"([^"]+)"/);
    if (pathMatch) {
      let oldS = extractJsonStringFieldRobust(text, 'old_str');
      if (oldS === null) oldS = extractJsonStringFieldRobust(text, 'oldStr');
      let newS = extractJsonStringFieldRobust(text, 'new_str');
      if (newS === null) newS = extractJsonStringFieldRobust(text, 'newStr');
      return {
        tool: 'edit',
        path: pathMatch[1],
        old_str: oldS !== null ? oldS : '',
        new_str: newS !== null ? newS : ''
      };
    }
  }

  const rawCode = extractJsonStringFieldRobust(text, 'code') ?? extractJsonStringFieldRobust(text, 'text');
  if (rawCode !== null) {
    return {
      tool: toolName,
      code: rawCode
    };
  }

  return null;
}

function extractToolCall(text) {
  // 1. Strict JSON first: balanced-brace extraction avoids the greedy-regex trap.
  const candidates = extractBalancedJsonObjects(text);
  for (const parsed of candidates) {
    if (!parsed || !parsed.tool) continue;
    if (KNOWN_TOOL_NAMES.has(parsed.tool) || typeof parsed.code === 'string') {
      return validateToolObject(parsed);
    }
  }

  // 2. Repair malformed JSON from the model, then validate the required fields.
  return validateToolObject(extractToolCallFallback(text));
}

/**
 * True when the streamed tool block is definitely finished.
 * A strictly parseable JSON object cannot grow further. For malformed JSON
 * (raw newlines, unescaped quotes) require a closed, brace-balanced block.
 */
function isToolBlockStructurallyComplete(text) {
  const value = String(text || '');
  if (extractBalancedJsonObjects(value).length > 0) return true;

  // Non-JSON raw code block (e.g. bash / powershell / sh)
  if (!text.includes('"tool"')) {
    // If it's pure shell script or text, it is complete once it has closing fence or is not currently growing
    if (value.trim().endsWith('```')) return true;
  }

  const trimmed = value.trim().replace(/```\s*$/, '').trimEnd();
  if (!trimmed.endsWith('}')) return false;

  // Two balances are checked because malformed model output can contain braces
  // inside the content string (with unescaped quotes, string tracking breaks).
  let naive = 0;
  let aware = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      naive++;
      if (!inString) aware++;
      continue;
    }
    if (ch === '}') {
      naive--;
      if (!inString) aware--;
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    }
  }
  return naive === 0 || aware === 0;
}

function scheduleToolRecheck(block, delay) {
  if (block.__duRecheckTimer) return;
  block.__duRecheckTimer = setTimeout(() => {
    block.__duRecheckTimer = null;
    if (block.isConnected) processToolCalls();
  }, delay);
}

/**
 * Wait until the streamed block is definitely complete. Partial content is
 * never executed: the old "best effort after a pause" path wrote files cut at
 * `{` or `(` whenever the model paused for a few seconds.
 * Returns true (execute), false (keep waiting) or 'incomplete' (give up loudly).
 */
function isToolBlockReady(block, codeText) {
  const now = Date.now();

  if (extractBalancedJsonObjects(codeText).length > 0) {
    if (block.__duRecheckTimer) {
      clearTimeout(block.__duRecheckTimer);
      block.__duRecheckTimer = null;
    }
    return true;
  }

  if (block.__duLastText !== codeText) {
    block.__duLastText = codeText;
    block.__duTextAt = now;
    scheduleToolRecheck(block, 900);
    return false;
  }

  const stableFor = now - (block.__duTextAt || 0);

  if (isToolBlockStructurallyComplete(codeText)) {
    if (stableFor < 800) {
      scheduleToolRecheck(block, 850);
      return false;
    }
    if (block.__duRecheckTimer) {
      clearTimeout(block.__duRecheckTimer);
      block.__duRecheckTimer = null;
    }
    return true;
  }

  // Still open. Waiting forever would hide a broken answer, so after a long
  // quiet period report it instead of executing truncated code.
  if (stableFor < 20000) {
    scheduleToolRecheck(block, 1000);
    return false;
  }

  if (block.__duRecheckTimer) {
    clearTimeout(block.__duRecheckTimer);
    block.__duRecheckTimer = null;
  }
  console.warn('[DeepUpgrade] Tool block stayed incomplete after 20s - refusing to execute it.');
  return 'incomplete';
}

// --- alternative tool-call syntaxes ---
// DeepSeek does not always honour the ```json:tool fence. It sometimes emits a
// bare <tool_call>{...}</tool_call> block or its native DSML markup. Both must be
// understood, including zero-width characters and arbitrary whitespace.
const DU_INVISIBLE_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD\u180E\u202A-\u202E]/g;

function stripInvisibleChars(text) {
  return String(text || '').replace(DU_INVISIBLE_RE, '');
}

// DSML delimiters: DeepSeek uses ASCII pipes or full-width bars, with single/double
// bars and arbitrary spacing (e.g. `< | | DSML | | calls>` or `<｜DSML｜calls>`).
const DSML_TAG_HEAD_RE = /<\s*(\/?)\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+/gi;

function normalizeDsml(text) {
  return String(text || '').replace(DSML_TAG_HEAD_RE, (match, slash) => '<' + (slash || '') + '|DSML||');
}

function parseDsmlToolCall(rawText) {
  const src = normalizeDsml(stripInvisibleChars(rawText));
  const invokeRe = /(?:<\|DSML\|\|invoke|<invoke)\s+name="([^"]+)"([^>]*)>/i;
  const inv = invokeRe.exec(src);
  if (!inv) return null;

  const toolName = (inv[1] || '').trim();
  const bodyStart = inv.index + inv[0].length;
  const closeRe = /(?:<\/\|DSML\|\|invoke\s*>|<\/invoke\s*>)/i;
  const closeMatch = closeRe.exec(src.slice(bodyStart));
  const body = closeMatch ? src.slice(bodyStart, bodyStart + closeMatch.index) : src.slice(bodyStart);

  const params = {};
  const paramRe = /(?:<\|DSML\|\|parameter|<parameter)\s+name="([^"]+)"([^>]*)>([\s\S]*?)(?:<\/\|DSML\|\|parameter\s*>|<\/parameter\s*>|$)/gi;
  let pm;
  while ((pm = paramRe.exec(body)) !== null) {
    let value = (pm[3] || '').trim();
    const attrs = pm[2] || '';
    // string="true" means the payload is raw text; anything else is JSON.
    if (!/string="true"/i.test(attrs)) {
      try { value = JSON.parse(value); } catch (e) { /* keep raw text */ }
    }
    params[pm[1]] = value;
    if (paramRe.lastIndex >= body.length) break;
  }

  return { toolName, params, complete: !!closeMatch };
}

function dsmlParamsToTool(toolName, params) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (params[key] !== undefined && params[key] !== null) return params[key];
    }
    return undefined;
  };
  const name = String(toolName || '').toLowerCase();

  switch (name) {
    case 'write':
    case 'write_file':
    case 'create':
      return { tool: 'write', path: pick('path', 'file', 'filename'), content: pick('content', 'text', 'body') ?? '' };
    case 'read':
    case 'read_file':
      return {
        tool: 'read',
        path: pick('path', 'file'),
        offset: parseInt(pick('offset') ?? '1', 10) || 1,
        limit: parseInt(pick('limit') ?? '2000', 10) || 2000
      };
    case 'edit':
    case 'str_replace':
    case 'replace':
      return {
        tool: 'edit',
        path: pick('path', 'file'),
        old_str: pick('old_str', 'oldStr', 'old_string') ?? '',
        new_str: pick('new_str', 'newStr', 'new_string') ?? ''
      };
    case 'bash':
    case 'shell':
    case 'sh':
    case 'terminal':
      return { tool: 'bash', code: pick('code', 'command', 'cmd', 'script') ?? '' };
    case 'python':
    case 'python3':
    case 'py':
      return { tool: 'python', code: pick('code', 'script', 'source') ?? '' };
    case 'js':
    case 'javascript':
      return { tool: 'js', code: pick('code', 'script', 'source') ?? '' };
    case 'grep':
    case 'search':
      return {
        tool: 'grep',
        pattern: pick('pattern', 'query', 'regex') ?? '',
        path: pick('path', 'dir', 'directory') ?? '/',
        include: pick('include', 'glob') ?? ''
      };
    case 'glob':
    case 'find':
      return { tool: 'glob', pattern: pick('pattern', 'glob') ?? '*', path: pick('path', 'dir') ?? '/' };
    case 'question':
    case 'ask':
      return { tool: 'question', question: pick('question', 'prompt') ?? '', options: pick('options') ?? [] };
    default:
      return { tool: name, ...params };
  }
}

function parseToolCallTag(rawText) {
  const src = stripInvisibleChars(rawText);
  const openRe = /<tool_call(?:\s[^>]*)?>/i;
  const open = openRe.exec(src);
  if (!open) return null;

  const bodyStart = open.index + open[0].length;
  const closeIdx = src.toLowerCase().indexOf('</tool_call>', bodyStart);
  const body = closeIdx === -1 ? src.slice(bodyStart) : src.slice(bodyStart, closeIdx);
  const toolObj = extractToolCall(body);
  if (!toolObj) return null;

  // A call is only safe to run when the tag is closed or the JSON is balanced.
  const balanced = extractBalancedJsonObjects(body).length > 0;
  return { toolObj, raw: body, complete: closeIdx !== -1 || balanced };
}

/**
 * Detect a tool call that is NOT inside a ```json:tool fence.
 * Returns { toolObj, kind, complete } or null.
 */
function parseInlineToolCall(rawText) {
  const dsml = parseDsmlToolCall(rawText);
  if (dsml && dsml.toolName) {
    const toolObj = validateToolObject(dsmlParamsToTool(dsml.toolName, dsml.params));
    if (toolObj && !toolObj.__parseError) {
      return { toolObj, kind: 'dsml', complete: dsml.complete };
    }
  }
  const tag = parseToolCallTag(rawText);
  if (tag) {
    return { toolObj: validateToolObject(tag.toolObj), kind: 'tool_call', complete: tag.complete };
  }
  return null;
}

/** Deepest element that fully contains the given needle. */
function findDeepestElementWith(root, needle) {
  if (!root || !needle) return null;
  let best = null;
  root.querySelectorAll('p, pre, div, span, code').forEach((el) => {
    const text = el.textContent || '';
    if (!text.includes(needle)) return;
    if (el.querySelector('p, pre, div, span, code')) return; // a child matches too -> not the deepest
    best = el;
  });
  return best;
}

/**
 * Climb to the element that carries the whole call (the deepest match is often
 * a single <span> around the opening tag). Never climbs past the message root.
 */
function climbToCallHost(el, msg, marker) {
  let node = el;
  while (node && node !== msg) {
    const parent = node.parentElement;
    if (!parent || parent === msg) break;
    if ((parent.textContent || '').includes(marker)) { node = parent; continue; }
    break;
  }
  return node;
}

/** Hide the raw markup of an inline tool call (it is replaced by the tool card). */
function hideInlineCallRegion(startEl) {
  if (!startEl) return;
  startEl.style.setProperty('display', 'none', 'important');
  let sib = startEl.nextElementSibling;
  let guard = 0;
  while (sib && guard++ < 12) {
    const text = (sib.textContent || '').trim();
    const looksLikeCall = /"tool"\s*:/.test(text) || /DSML/i.test(text) || /parameter\s+name=/.test(text);
    if (!looksLikeCall && text !== '') break;
    sib.style.setProperty('display', 'none', 'important');
    sib = sib.nextElementSibling;
  }
}

/**
 * Collect tool calls that the model emitted as plain text (no code fence).
 * They are attached to the element that holds them, so the usual tool card
 * replaces the raw markup.
 */
function collectInlineToolCalls() {
  const out = [];
  const messages = document.querySelectorAll('.ds-markdown');
  messages.forEach((msg) => {
    if (msg.closest('.fbb737a4')) return;              // user bubbles never hold tool calls
    const raw = msg.innerText || '';
    if (!raw) return;
    if (!/tool_call|DSML/i.test(raw)) return;

    const parsed = parseInlineToolCall(raw);
    if (!parsed || !parsed.complete) return;

    const isDsml = parsed.kind === 'dsml';
    const needle = isDsml
      ? (raw.match(/<[^>]*DSML[^>]*>/i) || ['DSML'])[0].slice(0, 24)
      : 'tool_call';
    const marker = isDsml ? 'DSML' : '"tool"';

    let el = findDeepestElementWith(msg, needle);
    if (!el) el = msg;
    if (el.closest('.md-code-block') || el.tagName.toLowerCase() === 'pre') return; // handled by the fenced path
    el = climbToCallHost(el, msg, marker);
    if (el.hasAttribute('data-du-rendered')) return;

    out.push({ block: el, toolObj: parsed.toolObj, kind: parsed.kind });
  });
  return out;
}

async function executeToolBlock(block, codeText, toolObj, alreadyComplete, latestHint) {
  // Never execute a block that is still streaming.
  if (!alreadyComplete) {
    const readiness = isToolBlockReady(block, codeText);
    if (readiness === false) {
      renderStreamingToolCard(block, toolObj);
      return;
    }
    if (readiness === 'incomplete') {
      block.setAttribute('data-du-rendered', 'true');
      const stuckWidget = renderOpenCode1to1(block, toolObj);
      setOpenCodeOutput(stuckWidget, '⚠️ Блок не дописан: выполнение отменено, чтобы не записать обрезанный файл.\nОтправьте запрос ещё раз.');
      duSendLog('tool-incomplete', { tool: toolObj.tool, chars: codeText.length, preview: codeText.slice(-80) });
      return;
    }
  }

  const blockHash = 'du_' + hashText(codeText.replace(/\s+/g, ''));
  const turnKey = getToolTurnKey(block);
  const blockKey = `${turnKey}|${blockHash}`;

  block.setAttribute('data-du-rendered', 'true');
  const toolWidget = renderOpenCode1to1(block, toolObj);

  // Auto-execution requires the user to have sent a message in this page
  // session (allowExecution). Agent mode alone must not re-run tool calls that
  // were already in chat history when the page loaded.
  const isAutoExecutionEligible = allowExecution && isAgentEnabled;

  // A malformed block must never reach the sandbox: writing an empty file and
  // reporting success is worse than showing a visible parse error.
  if (toolObj.__parseError) {
    console.warn('[DeepUpgrade] Tool parse error:', toolObj.__parseError, '\nRaw block:\n' + codeText);
    setOpenCodeOutput(toolWidget, `⚠️ ${toolObj.__parseError}\n\nИнструмент не выполнен, чтобы не повредить файлы.`);
    if (isAutoExecutionEligible) {
      await sendSilentReply(`[SANDBOX ERROR]: Tool invocation parsing failed: ${toolObj.__parseError}\nPlease fix your tool call syntax and try again.`);
    }
    return;
  }

  // Check if we already have output for this block:
  // - from memory / storage cache (sessionStorage or localStorage)
  // - or directly extracted from the following [SANDBOX OUTPUT] in chat history DOM
  let cached = findCachedOutput(blockKey);
  if (typeof cached !== 'string') {
    cached = findHistoricalOutputFromDom(block, toolObj);
    if (typeof cached === 'string') {
      markExecuted(turnKey, blockKey, cached);
    }
  }

  if (typeof cached === 'string') {
    setOpenCodeOutput(toolWidget, cached || '(no output)');
    if (toolObj.tool === 'question' || toolObj.tool === 'ask') {
      renderInteractiveQuestionCard(toolWidget, toolObj, true);
    }
    duSendLog('tool-skip-already-executed', { tool: toolObj.tool, turn: turnKey });
    return;
  }

  if (!isAutoExecutionEligible) {
    setOpenCodeOutput(toolWidget, isAgentEnabled
      ? 'Не выполнено: это сообщение из истории чата. Отправьте новое сообщение, чтобы запустить агента.'
      : 'Не выполнено: включите Agent, чтобы разрешить выполнение инструментов.');
    return;
  }

  // "Latest" is decided once for the whole batch: our own [SANDBOX OUTPUT]
  // reply inserts a new user bubble, which would make the remaining calls of
  // the same answer look like history.
  const isLatest = latestHint === undefined ? isLatestAssistantBlock(block) : latestHint;
  if (!isLatest) {
    // A newer user message exists: this call is history and must never run.
    setOpenCodeOutput(toolWidget, 'Исторический вызов: повторно не выполняется.');
    duSendLog('tool-skip-history', { tool: toolObj.tool, turn: turnKey });
    return;
  }

  markExecuted(turnKey);
  duSendLog('tool-execute', { tool: toolObj.tool, turn: turnKey, chars: (toolObj.code || toolObj.content || '').length });

  // If this is an interactive question tool, PAUSE loop and render interactive selection card
  if (toolObj.tool === 'question' || toolObj.tool === 'ask') {
    renderInteractiveQuestionCard(toolWidget, toolObj);
    return;
  }

  let outputStr = '';
  let isSuccess = true;

  if (pluginTools.has(toolObj.tool)) {
    const pTool = pluginTools.get(toolObj.tool);
    try {
      const pRes = await pTool.execute(toolObj.args || toolObj);
      outputStr = typeof pRes === 'string' ? pRes : JSON.stringify(pRes, null, 2);
    } catch (pErr) {
      isSuccess = false;
      outputStr = `Plugin Tool Error (${toolObj.tool}): ${pErr && pErr.message || pErr}`;
    }
  } else {
    const res = await runInSandbox(toolObj);
    isSuccess = res.success !== false;
    outputStr = typeof res.output === 'string' ? res.output : '';
  }

  // Notify registered onToolResult plugin hooks
  for (const hook of pluginHooks.onToolResult) {
    try { hook(toolObj.tool, outputStr); } catch (e) {}
  }

  setOpenCodeOutput(toolWidget, outputStr || '(no output)');

  // Record what was actually returned.
  markExecuted(turnKey, blockKey, outputStr);
  duSendLog('tool-output', {
    tool: toolObj.tool,
    success: isSuccess,
    outLen: outputStr.length,
    preview: outputStr.slice(0, 60)
  });
  if (outputStr.trim() === '') {
    duSendLog('tool-output-EMPTY', { tool: toolObj.tool, note: 'tool returned no output' });
  }

  // Apply configurable Context Limit to prevent Context Length Exceeded & DOM freeze
  const maxChars = getContextLimit();
  let effectiveOutput = outputStr;
  if (maxChars > 0 && outputStr.length > maxChars) {
    effectiveOutput = outputStr.slice(0, maxChars) +
      `\n\n... [ВЫВОД ОБРЕЗАН: показано ${maxChars} из ${outputStr.length} симв. Лимит настраивается во вкладке DeepUpgrade]`;
  }

  // Autonomous Multi-Turn ReAct loop:
  // Allow the agent to call multiple tools sequentially if needed, or conclude when finished
  const reply = `[SANDBOX OUTPUT (${toolObj.tool})]:\n${effectiveOutput}\n\nContinue with your next tool call if more steps are needed, or provide your final answer.`;
  await sendSilentReply(reply);
}

function processToolCalls() {
  // A tool call may only run when the user sent a message in this page
  // session. The interceptor knows that for sure.
  refreshAllowExecution();
  cleanAndUnifyChat();

  // Collect every tool call of the latest answers, in document order.
  const tasks = [];

  const allBlocks = Array.from(document.querySelectorAll('.md-code-block, pre'));
  for (const rawBlock of allBlocks) {
    let block = rawBlock;
    // If this is a <pre> whose parent .md-code-block is already processed, skip
    if (block.tagName.toLowerCase() === 'pre' && block.closest('.md-code-block')) {
      const parentBlock = block.closest('.md-code-block');
      if (parentBlock.hasAttribute('data-du-rendered')) continue;
      block = parentBlock; // Process the parent wrapper directly
    }

    if (block.hasAttribute('data-du-rendered')) continue;

    const codeText = block.innerText || '';
    const toolObj = extractToolCall(codeText);
    if (!toolObj) {
      // The answer is still streaming: show the tool card (shimmering label) as
      // soon as the tool name is readable instead of waiting for the full block.
      const partial = extractPartialToolMeta(codeText);
      if (partial) renderStreamingToolCard(block, partial);
      continue;
    }
    tasks.push({ block, codeText, toolObj, inline: false });
  }

  for (const call of collectInlineToolCalls()) {
    tasks.push({
      block: call.block,
      codeText: JSON.stringify(call.toolObj),
      toolObj: call.toolObj,
      inline: true
    });
  }

  if (tasks.length === 0) return;

  // Document order: the model asked for the calls in this order, so the
  // sandbox outputs must be sent back in the same order.
  tasks.sort((a, b) => {
    if (a.block === b.block) return 0;
    const rel = a.block.compareDocumentPosition(b.block);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  // Sequential execution: several calls inside one answer must not run in
  // parallel, otherwise their outputs arrive in the wrong order and the model
  // reacts to the wrong result.
  const latestFlags = new Map();
  for (const task of tasks) {
    latestFlags.set(task.block, isLatestAssistantBlock(task.block));
  }

  (async () => {
    for (const task of tasks) {
      try {
        if (task.inline) {
          hideInlineCallRegion(task.block);
          duSendLog('tool-inline-format', { tool: task.toolObj.tool });
        }
        await executeToolBlock(task.block, task.codeText, task.toolObj, task.inline, latestFlags.get(task.block));
      } catch (err) {
        console.error('[DeepUpgrade] tool processing failed:', err);
        duSendLog('tool-error', { error: String((err && err.message) || err) });
      }
    }
  })();
}

// Track active session for Todo panel auto-clear on new chat / session switch
let currentActiveChatSessionId = null;

function checkSessionChange() {
  const match = window.location.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/);
  const newSessionId = match ? match[1] : null;

  if (newSessionId !== currentActiveChatSessionId) {
    currentActiveChatSessionId = newSessionId;
    // If user navigated to root or new chat, clear sidebar todo!
    if (!newSessionId && activeSidebarTodoPanel) {
      activeSidebarTodoPanel.remove();
      activeSidebarTodoPanel = null;
    }
  }
}

// Persistent OpenCode Sidebar Todo Manager
let activeSidebarTodoPanel = null;

function updateSidebarTodoList(todos) {
  if (!Array.isArray(todos) || todos.length === 0) {
    if (activeSidebarTodoPanel) {
      activeSidebarTodoPanel.remove();
      activeSidebarTodoPanel = null;
    }
    return;
  }

  if (!activeSidebarTodoPanel || !document.body.contains(activeSidebarTodoPanel)) {
    activeSidebarTodoPanel = document.createElement('div');
    activeSidebarTodoPanel.className = 'du-todo-float-panel';
    document.body.appendChild(activeSidebarTodoPanel);
  }

  const itemsHtml = todos.map(item => {
    const isProgress = item.status === 'in_progress';
    const isDone = item.status === 'completed';

    // Exact SVG hourglass matching Figma vector: 8-shape hourglass
    const hourglassSvg = `
      <svg viewBox="0 0 14 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 1.5H12M2 14.5H12M3 1.5C3 6.5 11 6.5 11 1.5M3 14.5C3 9.5 11 9.5 11 14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    return `
      <div class="du-todo-item ${isProgress ? 'in-progress' : isDone ? 'completed' : 'pending'}">
        <div class="du-todo-marker">${hourglassSvg}</div>
        <span class="du-todo-title">${escapeHtml(item.content || '')}</span>
      </div>
    `;
  }).join('');

  activeSidebarTodoPanel.innerHTML = `
    <div class="du-todo-badge">
      <span>Progress</span>
      <svg class="du-todo-badge-icon" viewBox="0 0 14 16" fill="none">
        <path d="M2 1.5H12M2 14.5H12M3 1.5C3 6.5 11 6.5 11 1.5M3 14.5C3 9.5 11 9.5 11 14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="du-todo-list">
      ${itemsHtml}
    </div>
  `;
}

// <du-tool-card>
function getToolIcon(toolName, customIcon) {
  if (customIcon) {
    if (typeof customIcon === 'string' && customIcon.trim().startsWith('<svg')) {
      return customIcon;
    }
    const c = String(customIcon).toLowerCase();
    if (c === 'globe' || c === 'web' || c === 'fetch' || c === 'http') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    }
    if (c === 'terminal' || c === 'bash' || c === 'cmd' || c === 'shell') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
    }
    if (c === 'edit' || c === 'pencil') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    }
    if (c === 'search' || c === 'find') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    }
    if (c === 'calc' || c === 'calculator') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>`;
    }
    if (c === 'code' || c === 'js' || c === 'python') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    }
    if (c === 'database' || c === 'db') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`;
    }
    return `<span>${escapeHtml(customIcon)}</span>`;
  }

  const t = (toolName || '').toLowerCase();
  if (t === 'edit') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  }
  if (t === 'write') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
  }
  if (t === 'read') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  }
  if (t === 'glob' || t === 'grep') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  }
  if (t === 'todowrite' || t === 'todo') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
  }
  if (t === 'question' || t === 'ask') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  }
  if (t === 'python' || t === 'py') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
  }
  if (t === 'js') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
  }
  if (t.includes('web') || t.includes('http') || t.includes('fetch') || t.includes('search')) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
  }
  if (t === 'bash' || t === 'sh' || t === 'cmd' || t === 'terminal') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
}

function toolCardFileName(path) {
  return (path || 'file').split('/').filter(Boolean).pop() || path || 'file';
}

function toolCardCode(text) {
  return `<pre class="du-code-view">${escapeHtml(text || '')}</pre>`;
}

function toolCardPending(text) {
  return `<div class="du-code-streaming">${escapeHtml(text)}</div>`;
}

// While the model is still streaming a tool block the card is shown early so
// the shimmering label is visible; only the header is meaningful at that point.
function toolCardStreamingContent(toolObj) {
  const tool = (toolObj && toolObj.tool) || '';
  const path = (toolObj && toolObj.path) || '';
  const customTool = (typeof pluginTools !== 'undefined' && pluginTools.get) ? pluginTools.get(tool) : null;
  const iconHtml = getToolIcon(tool, customTool ? customTool.icon : null);

  if (customTool) {
    return {
      label: customTool.name,
      iconHtml,
      inputHtml: toolCardPending('Выполнение плагина…')
    };
  }
  if (tool === 'write') return { label: `Запись: ${toolCardFileName(path)}`, iconHtml, inputHtml: `<div class="du-diff-file-tag">${escapeHtml(path)}</div>${toolCardPending('Приём содержимого файла…')}` };
  if (tool === 'edit') return { label: `Правка: ${toolCardFileName(path)}`, iconHtml, inputHtml: `<div class="du-diff-file-tag">${escapeHtml(path)}</div>${toolCardPending('Приём правки…')}` };
  if (tool === 'read') return { label: `Чтение: ${toolCardFileName(path)}`, iconHtml, inputHtml: `<div class="du-diff-file-tag">${escapeHtml(path)}</div>${toolCardPending('Чтение файла…')}` };
  if (tool === 'python' || tool === 'py') return { label: 'Python', iconHtml, inputHtml: toolCardPending('Приём кода…') };
  if (tool === 'js') return { label: 'JavaScript', iconHtml, inputHtml: toolCardPending('Приём кода…') };
  if (tool === 'glob') return { label: `Поиск файлов: ${(toolObj && toolObj.pattern) || '*'}`, iconHtml, inputHtml: toolCardPending('Приём шаблона…') };
  if (tool === 'grep') return { label: `Поиск в коде: ${(toolObj && toolObj.pattern) || ''}`, iconHtml, inputHtml: toolCardPending('Приём шаблона…') };
  if (tool === 'todowrite' || tool === 'todo') return { label: 'План выполнения', iconHtml, inputHtml: toolCardPending('Обновление плана…') };
  return { label: 'Терминал', iconHtml, inputHtml: toolCardPending('Приём команды…') };
}

function toolCardContent(toolObj, streaming) {
  if (streaming) return toolCardStreamingContent(toolObj);

  const toolName = (toolObj && toolObj.tool) || '';
  const customTool = (typeof pluginTools !== 'undefined' && pluginTools.get) ? pluginTools.get(toolName) : null;
  const iconHtml = getToolIcon(toolName, customTool ? customTool.icon : null);

  let label = 'Терминал';
  let inputContent = '';

  if (customTool) {
    label = customTool.name;
    let argsText = '';
    try {
      const copy = { ...toolObj };
      delete copy.tool;
      delete copy.__parseError;
      argsText = Object.keys(copy).length > 0 ? JSON.stringify(copy, null, 2) : '';
    } catch (e) {
      argsText = '';
    }
    inputContent = `<div class="du-diff-file-tag">JS PLUGIN: ${escapeHtml(customTool.name)}</div>`
      + (argsText ? toolCardCode(argsText) : '<div style="opacity:0.7;font-size:12px;">Вызов инструмента</div>');
  } else if (toolObj.tool === 'todowrite' || toolObj.tool === 'todo') {
    const rawTodos = toolObj.todos || [];
    const todos = Array.isArray(rawTodos) ? rawTodos : [];
    label = 'План выполнения';
    
    // Update floating sidebar panel matching Figma design
    updateSidebarTodoList(todos);

    inputContent = `<div class="du-diff-file-tag">TODO PROGRESS UPDATED (${todos.length} tasks)</div><div style="opacity: 0.8; font-size: 12px;">План отображается в боковой панели Progress.</div>`;
  } else if (toolObj.tool === 'question' || toolObj.tool === 'ask') {
    label = `Вопрос: ${escapeHtml(toolObj.question || 'Выбор действия')}`;
    inputContent = `<div class="du-diff-file-tag">INTERACTIVE PROMPT</div><div style="font-size: 13px; font-weight: 500; margin-bottom: 8px;">${escapeHtml(toolObj.question || '')}</div>`;
  } else if (toolObj.tool === 'glob') {
    label = `Поиск файлов: ${toolObj.pattern || '*'}`;
    inputContent = `<div class="du-diff-file-tag">GLOB (${escapeHtml(toolObj.path || '/')})</div><div class="du-diff-add">+ ${escapeHtml(toolObj.pattern || '*')}</div>`;
  } else if (toolObj.tool === 'grep') {
    label = `Поиск в коде: ${toolObj.pattern || ''}`;
    inputContent = `<div class="du-diff-file-tag">GREP (${escapeHtml(toolObj.path || '/')})</div><div style="font-size: 11px; opacity: 0.85;">Паттерн: <code>${escapeHtml(toolObj.pattern || '')}</code>${toolObj.include ? ` [${escapeHtml(toolObj.include)}]` : ''}</div>`;
  } else if (toolObj.tool === 'read') {
    const filename = (toolObj.path || 'file').split('/').filter(Boolean).pop() || toolObj.path;
    label = `Чтение: ${filename}`;
    inputContent = `<div class="du-diff-file-tag">${escapeHtml(toolObj.path || '')}</div><div style="opacity: 0.7; font-size: 11px;">(offset: ${toolObj.offset || 1}, limit: ${toolObj.limit || 2000})</div>`;
  } else if (toolObj.tool === 'write') {
    const filename = (toolObj.path || 'file').split('/').filter(Boolean).pop() || toolObj.path;
    label = `Запись: ${filename}`;
    const content = toolObj.content || '';
    const lines = content.split('\n');
    const MAX_CODE_LINES = 800;
    const shown = lines.length > MAX_CODE_LINES ? lines.slice(0, MAX_CODE_LINES).join('\n') : content;
    const more = lines.length > MAX_CODE_LINES
      ? `<div class="du-code-more">… ещё ${lines.length - MAX_CODE_LINES} строк. Откройте файл через read, чтобы увидеть остальное.</div>`
      : '';
    const size = typeof Blob !== 'undefined' ? new Blob([content]).size : content.length;
    inputContent = `<div class="du-diff-file-tag">${escapeHtml(toolObj.path || '')} · ${lines.length} стр. · ${formatBytes(size)}</div>`
      + toolCardCode(shown) + more;
  } else if (toolObj.tool === 'edit') {
    const filename = toolCardFileName(toolObj.path);
    label = `Правка: ${filename}`;
    const oldLines = (toolObj.old_str || '').split('\n').map(l => `<div class="du-diff-del">- ${escapeHtml(l)}</div>`).join('');
    const newLines = (toolObj.new_str || '').split('\n').map(l => `<div class="du-diff-add">+ ${escapeHtml(l)}</div>`).join('');
    inputContent = `<div class="du-diff-file-tag">${escapeHtml(toolObj.path || '')}</div><div class="du-diff-scroll">${oldLines}${newLines}</div>`;
  } else if (toolObj.tool === 'install_skill' || toolObj.tool === 'add_skill') {
    label = `Установка скилла: ${toolObj.name || 'Custom Skill'}`;
    inputContent = `<div class="du-diff-file-tag">SKILL REGISTRY</div><div class="du-diff-add">+ ${escapeHtml(toolObj.desc || '')}</div>`;
  } else if (toolObj.tool === 'python' || toolObj.tool === 'py') {
    label = 'Python';
    inputContent = toolCardCode(toolObj.code);
  } else if (toolObj.tool === 'js') {
    label = 'JavaScript';
    inputContent = toolCardCode(toolObj.code);
  } else {
    label = 'Терминал';
    inputContent = toolCardCode(toolObj.code);
  }

  return { label, iconHtml, inputHtml: inputContent };
}

function toolCardKey(toolObj) {
  const body = toolObj.content || toolObj.code || toolObj.new_str || '';
  return [toolObj.tool, toolObj.path || '', body.length].join('|');
}

function applyToolCardContent(root, toolObj, streaming) {
  const { label, iconHtml, inputHtml } = toolCardContent(toolObj || {}, streaming);
  let iconEl = root.querySelector('.opencode-tool-icon');
  if (!iconEl) {
    const btn = root.querySelector('.opencode-tool-header-btn');
    if (btn) {
      iconEl = document.createElement('span');
      iconEl.className = 'opencode-tool-icon';
      btn.insertBefore(iconEl, btn.firstChild);
    }
  }
  if (iconEl && iconHtml && iconEl.__duIcon !== iconHtml) {
    iconEl.__duIcon = iconHtml;
    iconEl.innerHTML = iconHtml;
  }
  const textEl = root.querySelector('.opencode-tool-text');
  if (textEl && textEl.textContent !== label) textEl.textContent = label;
  const inputEl = root.querySelector('.opencode-terminal-input');
  if (!inputEl) return;
  const key = (streaming ? 'stream:' : 'final:') + label + (streaming ? '' : '|' + toolCardKey(toolObj));
  if (inputEl.__duKey === key) return;
  inputEl.__duKey = key;
  inputEl.innerHTML = inputHtml;
}

function createToolCard() {
  const root = document.createElement('div');
  root.className = 'opencode-tool-root';
  root.setAttribute('data-open', 'false');
  root.setAttribute('data-running', 'true');
  root.innerHTML = `
    <button class="opencode-tool-header-btn" type="button">
      <span class="opencode-tool-icon"></span>
      <span class="opencode-tool-text"></span>
      <svg class="opencode-tool-caret" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="opencode-terminal-box">
      <div class="opencode-terminal-input"></div>
      <div class="opencode-terminal-output">Вычисление...</div>
    </div>
  `;
  const btn = root.querySelector('.opencode-tool-header-btn');
  const toggle = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const isOpen = root.getAttribute('data-open') === 'true';
    root.setAttribute('data-open', !isOpen ? 'true' : 'false');
  };
  btn.onclick = toggle;
  btn.addEventListener('click', toggle, { capture: true });
  return root;
}

function hideNativeToolActions(root) {
  const parentVirtualRow = root.closest('div._9663006') || root.closest('div[data-virtual-list-item-key]');
  if (!parentVirtualRow) return;
  const act = parentVirtualRow.querySelector('div.ds-flex._0a3d93b');
  if (act) act.style.setProperty('display', 'none', 'important');
}

function findStreamingToolCard(block) {
  if (block.__duStreamWidget && block.__duStreamWidget.isConnected) return block.__duStreamWidget;
  const scope = block.closest('.ds-message') || block.closest('[data-virtual-list-item-key]') || block.parentElement;
  if (!scope) return null;
  return scope.querySelector('.opencode-tool-root[data-du-streaming="true"]');
}

// Shown while the answer is still streaming: the shimmering label appears at once
// instead of only after the whole file content has been written out.
function renderStreamingToolCard(block, toolObj) {
  if (!toolObj || !toolObj.tool) return;
  let root = findStreamingToolCard(block);
  if (!root) {
    const host = block.parentNode;
    if (!host) return;
    root = createToolCard();
    root.setAttribute('data-du-streaming', 'true');
    host.insertBefore(root, block.nextSibling);
  }
  applyToolCardContent(root, toolObj, true);
  block.__duStreamWidget = root;
}

function extractPartialToolMeta(codeText) {
  if (!codeText) return null;
  const toolMatch = codeText.match(/"tool"\s*:\s*"([a-zA-Z_]+)"/);
  if (!toolMatch) return null;
  const pathMatch = codeText.match(/"path"\s*:\s*"([^"]*)"/);
  const patternMatch = codeText.match(/"pattern"\s*:\s*"([^"]*)"/);
  return {
    tool: toolMatch[1].toLowerCase(),
    path: pathMatch ? pathMatch[1] : '',
    pattern: patternMatch ? patternMatch[1] : '',
    __partial: true
  };
}

function renderOpenCode1to1(originalPre, toolObj) {
  const targetToReplace = originalPre.closest('.md-code-block') || originalPre;
  targetToReplace.setAttribute('data-du-widget-attached', 'true');

  let root = originalPre.__duStreamWidget || targetToReplace.__duStreamWidget;
  if (root && !root.isConnected) root = null;

  if (root) {
    // Reuse the card that already appeared while the block was streaming.
    root.removeAttribute('data-du-streaming');
  } else {
    root = createToolCard();
    if (targetToReplace.parentNode) targetToReplace.parentNode.appendChild(root);
  }

  applyToolCardContent(root, toolObj, false);

  // The finished card replaces the raw JSON block.
  targetToReplace.style.setProperty('display', 'none', 'important');
  root.__duBlock = targetToReplace;
  targetToReplace.__duWidget = root;
  hideNativeToolActions(root);

  return root;
}
// </du-tool-card>


function setOpenCodeOutput(widget, output) {
  if (!widget) return;
  widget.setAttribute('data-running', 'false');
  const outEl = widget.querySelector('.opencode-terminal-output');
  if (outEl) outEl.innerText = output;
}

function renderInteractiveQuestionCard(widgetRoot, toolObj, isResolved = false) {
  if (!widgetRoot) return;
  widgetRoot.setAttribute('data-open', 'true');
  widgetRoot.setAttribute('data-running', isResolved ? 'false' : 'true');

  const container = widgetRoot.querySelector('.opencode-terminal-box');
  if (!container || container.querySelector('.du-question-card')) return;

  const card = document.createElement('div');
  card.className = 'du-question-card';

  const optionsHtml = (toolObj.options || []).map((opt, idx) => `
    <button type="button" class="du-question-opt-btn" data-opt="${escapeHtml(opt)}">
      <span class="du-question-radio"></span>
      <span class="du-question-text">${escapeHtml(opt)}</span>
    </button>
  `).join('');

  card.innerHTML = `
    <div class="du-question-header">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span>${escapeHtml(toolObj.question || 'Выберите вариант продолжения:')}</span>
    </div>
    <div class="du-question-options">${optionsHtml}</div>
    ${!isResolved ? `
      <div class="du-question-custom-row">
        <input type="text" class="du-question-input" placeholder="Или напишите свой вариант..." />
        <button type="button" class="du-question-submit-btn">Отправить ответ</button>
      </div>
    ` : `<div style="font-size: 11px; opacity: 0.7; margin-top: 8px;">Выбор сделан.</div>`}
  `;

  if (!isResolved) {
    let selectedOption = '';
    const optButtons = card.querySelectorAll('.du-question-opt-btn');
    const customInput = card.querySelector('.du-question-input');
    const submitBtn = card.querySelector('.du-question-submit-btn');

    optButtons.forEach(btn => {
      btn.onclick = () => {
        optButtons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedOption = btn.getAttribute('data-opt') || '';
        if (customInput) customInput.value = '';
      };
    });

    if (customInput) {
      customInput.oninput = () => {
        optButtons.forEach(b => b.classList.remove('selected'));
        selectedOption = customInput.value.trim();
      };
      customInput.onkeydown = (e) => {
        if (e.key === 'Enter') submitBtn.click();
      };
    }

    submitBtn.onclick = () => {
      const finalChoice = (customInput && customInput.value.trim()) || selectedOption;
      if (!finalChoice) {
        alert('Пожалуйста, выберите один из вариантов или напишите свой!');
        return;
      }

      // Lock card to resolved state
      card.innerHTML = `
        <div class="du-question-header" style="color: #10b981;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Ответ отправлен агенту: <b>${escapeHtml(finalChoice)}</b></span>
        </div>
      `;
      widgetRoot.setAttribute('data-running', 'false');

      // Send silent reply to wake up the ReAct agent loop
      const reply = `[USER ANSWER]: "${finalChoice}"\n\nPlease proceed with this choice.`;
      sendSilentReply(reply);
    };
  }

  container.appendChild(card);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Native Settings Tab: File Manager (durable OPFS tree) ---
const DU_FILE_PREVIEW_LIMIT = 120 * 1024;

function duFileIcon(name, isPicture) {
  if (isPicture) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
    </svg>`;
  }
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
  </svg>`;
}

function duFormatDate(mtime) {
  try {
    const d = new Date(mtime || Date.now());
    return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

async function renderNativeFilesContent() {
  const contentArea = document.querySelector('.ds-scroll-area__content._2db4123');
  if (!contentArea) return;

  // Hide original settings items (Theme, Language, Voice)
  Array.from(contentArea.children).forEach(ch => {
    if (!ch.classList.contains('du-native-files-panel')) {
      ch.style.display = 'none';
    }
  });

  let panel = contentArea.querySelector('.du-native-files-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'du-native-files-panel';
    contentArea.appendChild(panel);
  }

  const store = duVfsStore();
  let files = [];
  let mode = 'memory';
  try {
    if (store) {
      mode = await store.init();
      files = await store.listAll();
    }
  } catch (err) {
    console.warn('[DeepUpgrade] File manager listing failed:', err);
  }

  files = files.filter(f => f && f.path && !f.path.endsWith('/'));
  files.sort((a, b) => a.path.localeCompare(b.path));

  const groups = new Map();
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const name = parts.pop() || file.path;
    const dir = '/' + parts.join('/');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ ...file, name });
  }

  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

  let listHtml = '';
  if (files.length === 0) {
    listHtml = `
      <div class="du-skills-empty-state">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M1.5 5.5a1 1 0 011-1h5l2 2.5h11a1 1 0 011 1v10a1 1 0 01-1 1h-18a1 1 0 01-1-1v-12z" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="du-empty-text">Файлов пока нет</div>
        <div class="du-empty-hint">Файлы, созданные агентом в Python или шелле, попадут сюда автоматически и переживут перезагрузку страницы</div>
      </div>
    `;
  } else {
    listHtml = [...groups.entries()].map(([dir, items]) => `
      <div class="du-files-group">
        <div class="du-files-group-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
            <path d="M1.5 5.5a1 1 0 011-1h5l2 2.5h11a1 1 0 011 1v10a1 1 0 01-1 1h-18a1 1 0 01-1-1v-12z"/>
          </svg>
          <span>${escapeHtml(dir === '/' ? '/' : dir)}</span>
        </div>
        ${items.map(item => {
          const isPic = isImageFile(item.name);
          return `
          <div class="du-files-row" data-path="${escapeAttr(item.path)}">
            <div class="du-files-icon ${isPic ? 'is-image' : ''}">${duFileIcon(item.name, isPic)}</div>
            <div class="du-files-info">
              <div class="du-files-name" title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</div>
              <div class="du-files-meta">${formatBytes(item.size || 0)} • ${escapeHtml(duFormatDate(item.mtime))}</div>
            </div>
            <div class="du-files-actions">
              <button class="du-files-btn du-files-preview-btn" title="Просмотр" type="button">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <button class="du-files-btn du-files-download-btn" title="Скачать" type="button">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
              <button class="du-files-btn du-files-delete-btn" title="Удалить" type="button">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>
                </svg>
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `).join('');
  }

  panel.innerHTML = `
    <div class="du-native-files-container">
      <div class="du-native-header-row">
        <div>
          <div class="du-native-title">Файлы</div>
          <div class="du-native-sub">${mode === 'opfs' ? 'Дюрабельное хранилище OPFS' : 'Временное хранилище (OPFS недоступен)'}</div>
        </div>
        <div class="du-files-head-actions">
          <span class="du-native-badge">${files.length} • ${formatBytes(totalSize)}</span>
          <button class="du-files-btn du-files-refresh-btn" title="Обновить" type="button">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 11-2.6-6.4"/><polyline points="21 3 21 9 15 9"/>
            </svg>
          </button>
          <button class="du-files-btn du-files-upload-btn" title="Загрузить свой файл" type="button">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </button>
        </div>
      </div>

      <input type="file" id="duFilesInput" multiple style="display: none;" />

      <div class="du-native-files-list">
        ${listHtml}
      </div>

      <div class="du-files-preview" hidden></div>
    </div>
  `;

  // Refresh
  const refreshBtn = panel.querySelector('.du-files-refresh-btn');
  if (refreshBtn) refreshBtn.onclick = () => renderNativeFilesContent();

  // Upload own files -> durable store + sandbox VFS (the agent sees them too)
  const uploadBtn = panel.querySelector('.du-files-upload-btn');
  const fileInput = panel.querySelector('#duFilesInput');
  if (uploadBtn && fileInput) {
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const picked = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const file of picked) {
        try {
          await duStoreUploadedFile(file);
        } catch (err) {
          console.warn('[DeepUpgrade] Upload failed:', file.name, err);
        }
      }
      renderNativeFilesContent();
    };
  }

  // Preview / download / delete
  panel.querySelectorAll('.du-files-row').forEach(row => {
    const path = row.getAttribute('data-path');
    const name = path.split('/').filter(Boolean).pop() || path;

    const previewBtn = row.querySelector('.du-files-preview-btn');
    if (previewBtn) previewBtn.onclick = (e) => { e.stopPropagation(); duShowFilePreview(panel, path, name); };

    const downloadBtn = row.querySelector('.du-files-download-btn');
    if (downloadBtn) downloadBtn.onclick = (e) => { e.stopPropagation(); duDownloadFile(path, name); };

    const deleteBtn = row.querySelector('.du-files-delete-btn');
    if (deleteBtn) deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить файл ${name}?`)) return;
      await duDeleteFile(path);
      renderNativeFilesContent();
    };
  });
}

async function duStoreUploadedFile(file) {
  const safeName = sanitizeFileName(file.name);
  const isPic = isImageFile(file.name, file.type);
  const vfsPath = `${isPic ? '/added/picture' : '/added/file'}/${safeName}`;

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const base64 = duBytesToBase64(bytes);
  const text = duDecodeUtf8OrNull(bytes);

  // 1. Durable host copy
  const store = duVfsStore();
  if (store) {
    await store.writeFileQueued(vfsPath, text !== null ? text : base64, text !== null ? 'utf8' : 'base64');
  }

  // 2. Sandbox copy, so the agent can read the file right away
  if (sandboxIframe && sandboxIframe.contentWindow) {
    try {
      sandboxIframe.contentWindow.postMessage({
        type: 'DU_STORE_ATTACHMENT',
        path: vfsPath,
        data: base64,
        isBinary: true,
        mtime: Date.now()
      }, '*');
    } catch (e) {}
  }

  stagedAttachments.set(safeName, {
    name: file.name,
    path: vfsPath,
    type: file.type || (isPic ? 'image/png' : 'application/octet-stream'),
    size: file.size,
    isPicture: isPic,
    fromFileManager: true,
    mtime: Date.now()
  });
  publishDirectiveToMainWorld(true);

  return vfsPath;
}

async function duDownloadFile(path, name) {
  const res = await fetchFileFromSandbox(path);
  if (!res || !res.success || !res.base64) {
    alert('Не удалось прочитать файл: ' + ((res && res.error) || 'файл не найден'));
    return;
  }
  try {
    const bytes = duBase64ToBytes(res.base64);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name || path.split('/').pop() || 'file';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    alert('Ошибка сохранения файла: ' + (err && err.message));
  }
}

async function duShowFilePreview(panel, path, name) {
  const box = panel.querySelector('.du-files-preview');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="du-files-preview-head">
      <span class="du-files-preview-title">${escapeHtml(name)}</span>
      <button class="du-files-btn du-files-preview-close" title="Закрыть" type="button">✕</button>
    </div>
    <div class="du-files-preview-body">Загрузка…</div>`;

  const closeBtn = box.querySelector('.du-files-preview-close');
  if (closeBtn) closeBtn.onclick = () => { box.hidden = true; box.innerHTML = ''; };

  const body = box.querySelector('.du-files-preview-body');
  const res = await fetchFileFromSandbox(path);
  if (!body) return;

  if (!res || !res.success || !res.base64) {
    body.innerHTML = `<div class="du-files-preview-error">${escapeHtml((res && res.error) || 'Файл не найден')}</div>`;
    return;
  }

  const isPic = isImageFile(name);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const bytes = duBase64ToBytes(res.base64);
  const text = duDecodeUtf8OrNull(bytes);

  if (isPic) {
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
    body.innerHTML = `<img class="du-files-preview-image" src="data:${mime};base64,${res.base64}" alt="${escapeAttr(name)}" />`;
  } else if (text !== null) {
    const truncated = text.length > DU_FILE_PREVIEW_LIMIT;
    const shown = truncated ? text.slice(0, DU_FILE_PREVIEW_LIMIT) : text;
    body.innerHTML = `<pre class="du-files-preview-text">${escapeHtml(shown)}</pre>${truncated ? '<div class="du-files-preview-note">Показаны первые ' + Math.round(DU_FILE_PREVIEW_LIMIT / 1024) + ' КБ</div>' : ''}`;
  } else {
    body.innerHTML = `<div class="du-files-preview-error">Бинарный файл (${formatBytes(res.size || bytes.length)})</div>`;
  }
}

async function duDeleteFile(path) {
  const store = duVfsStore();
  if (store) {
    try {
      await store.removeEntryQueued(path);
    } catch (err) {
      console.warn('[DeepUpgrade] Delete failed:', path, err);
    }
  }
  if (sandboxIframe && sandboxIframe.contentWindow) {
    try {
      sandboxIframe.contentWindow.postMessage({ type: 'DU_REMOVE_ATTACHMENT', path }, '*');
    } catch (e) {}
  }
  for (const [key, info] of [...stagedAttachments.entries()]) {
    if (info.path === path) stagedAttachments.delete(key);
  }
}

// --- Native Settings Tab: Skills + Files + DeepUpgrade Integration ---
let isSkillsTabActive = false;
let isFilesTabActive = false;
let isConfigTabActive = false;
let duSkillsNavBtn = null;
let duFilesNavBtn = null;
let duConfigNavBtn = null;

function injectSkillsSettingsButton() {
  const settingsNav = document.querySelector('.d316d158');
  if (!settingsNav) return;

  if (!settingsNav.querySelector('.du-skills-nav-btn')) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.className = 'ds-button ds-button--outlinedNeutral ds-button--borderless ds-button--capsule ds-button--m ds-button--icon-relative-m ds-button--min-width _266abb8 du-skills-nav-btn';
    btn.style.cssText = '--dsl-button-text-color: var(--dsw-alias-label-primary); --dsl-button-padding: 0 10px 0 8px; --dsl-button-border-radius: 12px; --dsl-button-icon-gap: 8px; cursor: pointer;';

    btn.innerHTML = `
    <div class="ds-button__background"></div>
    <div class="ds-button__icon">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8.5 1.5L2.5 9H7.5L6.5 14.5L13.5 7H8.5L9.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <span class="ds-button__content">Skills</span>
  `;

    btn.onclick = (e) => {
      e.stopPropagation();
      activateSkillsTab(btn, settingsNav);
    };

    settingsNav.appendChild(btn);
    duSkillsNavBtn = btn;
  }

  if (!settingsNav.querySelector('.du-files-nav-btn')) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.className = 'ds-button ds-button--outlinedNeutral ds-button--borderless ds-button--capsule ds-button--m ds-button--icon-relative-m ds-button--min-width _266abb8 du-files-nav-btn';
    btn.style.cssText = '--dsl-button-text-color: var(--dsw-alias-label-primary); --dsl-button-padding: 0 10px 0 8px; --dsl-button-border-radius: 12px; --dsl-button-icon-gap: 8px; cursor: pointer;';

    btn.innerHTML = `
    <div class="ds-button__background"></div>
    <div class="ds-button__icon">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.5 4.5a1 1 0 011-1h3.2a1 1 0 01.77.36l.83 1.01a1 1 0 00.77.36H13.5a1 1 0 011 1v6.27a1 1 0 01-1 1h-11a1 1 0 01-1-1V4.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
    </div>
    <span class="ds-button__content">Files</span>
  `;

    btn.onclick = (e) => {
      e.stopPropagation();
      activateFilesTab(btn, settingsNav);
    };

    settingsNav.appendChild(btn);
    duFilesNavBtn = btn;
  }

  if (!settingsNav.querySelector('.du-config-nav-btn')) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.className = 'ds-button ds-button--outlinedNeutral ds-button--borderless ds-button--capsule ds-button--m ds-button--icon-relative-m ds-button--min-width _266abb8 du-config-nav-btn';
    btn.style.cssText = '--dsl-button-text-color: var(--dsw-alias-label-primary); --dsl-button-padding: 0 10px 0 8px; --dsl-button-border-radius: 12px; --dsl-button-icon-gap: 8px; cursor: pointer;';

    btn.innerHTML = `
    <div class="ds-button__background"></div>
    <div class="ds-button__icon">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    </div>
    <span class="ds-button__content">DeepUpgrade</span>
  `;

    btn.onclick = (e) => {
      e.stopPropagation();
      activateConfigTab(btn, settingsNav);
    };

    settingsNav.appendChild(btn);
    duConfigNavBtn = btn;
  }

  // When clicking any original DeepSeek tab, restore the original content
  const origTabs = settingsNav.querySelectorAll('div[role="button"]:not(.du-skills-nav-btn):not(.du-files-nav-btn):not(.du-config-nav-btn)');
  origTabs.forEach(t => {
    if (t.getAttribute('data-du-tab-bound') === 'true') return;
    t.setAttribute('data-du-tab-bound', 'true');
    t.addEventListener('click', () => {
      deactivateSkillsTab(duSkillsNavBtn, settingsNav);
      deactivateFilesTab(duFilesNavBtn, settingsNav);
      deactivateConfigTab(duConfigNavBtn, settingsNav);
    }, { capture: true });
  });
}

function activateSkillsTab(skillsBtn, settingsNav) {
  if (duFilesNavBtn) deactivateFilesTab(duFilesNavBtn, settingsNav);
  if (duConfigNavBtn) deactivateConfigTab(duConfigNavBtn, settingsNav);
  isSkillsTabActive = true;

  // Un-highlight other tabs, highlight Skills
  settingsNav.querySelectorAll('div[role="button"]').forEach(t => {
    t.classList.remove('_699d482');
    t.style.removeProperty('--dsl-button-color');
  });
  skillsBtn.classList.add('_699d482');
  skillsBtn.style.setProperty('--dsl-button-color', 'var(--dsw-alias-interactive-bg-hover)');

  renderNativeSkillsContent();
}

function deactivateSkillsTab(skillsBtn, settingsNav) {
  isSkillsTabActive = false;
  if (skillsBtn) {
    skillsBtn.classList.remove('_699d482');
    skillsBtn.style.removeProperty('--dsl-button-color');
  }

  const contentArea = document.querySelector('.ds-scroll-area__content._2db4123');
  if (contentArea) {
    const customPanel = contentArea.querySelector('.du-native-skills-panel');
    if (customPanel) customPanel.remove();
    // Unhide original children
    Array.from(contentArea.children).forEach(ch => {
      ch.style.removeProperty('display');
    });
  }
}

function activateFilesTab(filesBtn, settingsNav) {
  if (duSkillsNavBtn) deactivateSkillsTab(duSkillsNavBtn, settingsNav);
  if (duConfigNavBtn) deactivateConfigTab(duConfigNavBtn, settingsNav);
  isFilesTabActive = true;

  settingsNav.querySelectorAll('div[role="button"]').forEach(t => {
    t.classList.remove('_699d482');
    t.style.removeProperty('--dsl-button-color');
  });
  filesBtn.classList.add('_699d482');
  filesBtn.style.setProperty('--dsl-button-color', 'var(--dsw-alias-interactive-bg-hover)');

  renderNativeFilesContent();
}

function deactivateFilesTab(filesBtn, settingsNav) {
  isFilesTabActive = false;
  if (filesBtn) {
    filesBtn.classList.remove('_699d482');
    filesBtn.style.removeProperty('--dsl-button-color');
  }

  const contentArea = document.querySelector('.ds-scroll-area__content._2db4123');
  if (contentArea) {
    const customPanel = contentArea.querySelector('.du-native-files-panel');
    if (customPanel) customPanel.remove();
    Array.from(contentArea.children).forEach(ch => {
      ch.style.removeProperty('display');
    });
  }
}

function activateConfigTab(configBtn, settingsNav) {
  if (duSkillsNavBtn) deactivateSkillsTab(duSkillsNavBtn, settingsNav);
  if (duFilesNavBtn) deactivateFilesTab(duFilesNavBtn, settingsNav);
  isConfigTabActive = true;

  settingsNav.querySelectorAll('div[role="button"]').forEach(t => {
    t.classList.remove('_699d482');
    t.style.removeProperty('--dsl-button-color');
  });
  configBtn.classList.add('_699d482');
  configBtn.style.setProperty('--dsl-button-color', 'var(--dsw-alias-interactive-bg-hover)');

  renderNativeConfigContent();
}

function deactivateConfigTab(configBtn, settingsNav) {
  isConfigTabActive = false;
  if (configBtn) {
    configBtn.classList.remove('_699d482');
    configBtn.style.removeProperty('--dsl-button-color');
  }

  const contentArea = document.querySelector('.ds-scroll-area__content._2db4123');
  if (contentArea) {
    const customPanel = contentArea.querySelector('.du-native-config-panel');
    if (customPanel) customPanel.remove();
    Array.from(contentArea.children).forEach(ch => {
      ch.style.removeProperty('display');
    });
  }
}

function renderNativeConfigContent() {
  const contentArea = document.querySelector('.ds-scroll-area__content._2db4123');
  if (!contentArea) return;

  // Hide original settings items (Theme, Language, Voice)
  Array.from(contentArea.children).forEach(ch => {
    if (!ch.classList.contains('du-native-config-panel')) {
      ch.style.display = 'none';
    }
  });

  let panel = contentArea.querySelector('.du-native-config-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'du-native-config-panel du-native-skills-panel';
    contentArea.appendChild(panel);
  }

  const currentLimit = getContextLimit();
  const plugins = getStoredPlugins();

  panel.innerHTML = `
    <div class="du-native-skills-container">
      <div class="du-native-header-row">
        <div>
          <div class="du-native-title">DeepUpgrade Settings</div>
          <div class="du-native-sub">Управление лимитом контекста и JavaScript-плагинами</div>
        </div>
        <span class="du-native-badge">${plugins.filter(p => p.enabled).length} плагинов акт.</span>
      </div>

      <!-- Section: Context Limit -->
      <div class="du-native-add-box" style="margin-top: 0;">
        <div class="du-native-add-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
            <line x1="6" y1="6" x2="6.01" y2="6"></line>
            <line x1="6" y1="18" x2="6.01" y2="18"></line>
          </svg>
          <span class="du-native-add-title">Ограничение контекста вывода (Tool Context Limit)</span>
        </div>
        <div style="font-size: 12px; color: var(--dsw-alias-label-tertiary, #94a3b8); margin: 6px 0 12px;">
          Максимальное число символов вывода одного инструмента, отправляемое в LLM. Предотвращает ошибку Context Overflow и зависание браузера при больших выводах.
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          ${[
            { label: '8 KB (8 тыс.)', val: 8000 },
            { label: '16 KB (Рекомендуется)', val: 16000 },
            { label: '32 KB (32 тыс.)', val: 32000 },
            { label: '64 KB (64 тыс.)', val: 64000 },
            { label: 'Без лимита', val: 0 }
          ].map(p => `
            <button class="du-limit-pill" data-val="${p.val}" type="button" style="padding: 6px 12px; border-radius: 8px; border: 1px solid ${currentLimit === p.val ? '#3b82f6' : 'rgba(255,255,255,0.1)'}; background: ${currentLimit === p.val ? 'rgba(59,130,246,0.2)' : 'rgba(0,0,0,0.2)'}; color: ${currentLimit === p.val ? '#60a5fa' : 'inherit'}; cursor: pointer; font-size: 12px; font-weight: ${currentLimit === p.val ? '600' : '400'};">
              ${p.label}
            </button>
          `).join('')}
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 12.5px; color: var(--dsw-alias-label-secondary, #cbd5e1);">Точный лимит символов:</span>
          <input class="du-input du-custom-limit-input" type="number" min="0" max="1000000" step="1000" value="${currentLimit}" style="width: 140px; padding: 6px 10px;" />
          <span class="du-limit-status" style="font-size: 12px; color: #10b981; font-weight: 500; display: none;">✓ Сохранено</span>
        </div>
      </div>

      <!-- Section: JS Plugins -->
      <div class="du-native-skills-list" style="margin-top: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <div style="font-size: 14px; font-weight: 600;">Установленные JS-плагины</div>
          <button class="du-btn-primary du-load-sample-plugin-btn" type="button" style="padding: 4px 10px; font-size: 11px;">+ Загрузить пример плагина</button>
        </div>
        ${plugins.length === 0 ? `
          <div class="du-skills-empty-state" style="padding: 24px; text-align: center;">
            <div class="du-empty-text" style="font-size: 14px; font-weight: 500;">Нет установленных JS-плагинов</div>
            <div class="du-empty-hint" style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Перетащите ZIP-архив с плагином ниже для установки.</div>
          </div>
        ` : plugins.map(p => {
          const fileKeys = p.files ? Object.keys(p.files) : [];
          const assetCount = fileKeys.length;
          return `
          <div class="du-native-skill-row" style="flex-direction: column; align-items: stretch; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div class="du-native-skill-info">
                <div class="du-native-skill-title" style="display: flex; align-items: center; gap: 6px;">
                  <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${p.enabled ? '#10b981' : '#71717a'}; flex-shrink: 0;"></span>
                  <span class="du-skill-main-name" style="font-weight: 600;">${escapeHtml(p.name)}</span>
                  <span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); color: #94a3b8;">v${escapeHtml(p.version || '1.0.0')}</span>
                </div>
                <div class="du-native-skill-desc" style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${escapeHtml(p.desc || 'ZIP-плагин')}</div>
                <div style="font-size: 11px; color: #64748b; margin-top: 3px;">
                  Точка входа: <code>${escapeHtml(p.entryFile || 'index.js')}</code> • ${assetCount > 0 ? `${assetCount} файл(ов)/ассет(ов)` : 'Одиночный скрипт'}
                </div>
              </div>
              <div class="du-native-skill-controls" style="display: flex; align-items: center; gap: 8px;">
                <button class="du-toggle-files-btn" data-plugin-id="${p.id}" type="button" style="background: none; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: inherit; padding: 4px 8px; font-size: 11px; cursor: pointer;">
                  Файлы (${assetCount})
                </button>
                <label class="du-switch">
                  <input type="checkbox" data-plugin-id="${p.id}" ${p.enabled ? 'checked' : ''}>
                  <span class="du-slider"></span>
                </label>
                <button class="du-native-del-btn" data-del-plugin="${p.id}" title="Удалить плагин">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z"/>
                  </svg>
                </button>
              </div>
            </div>
            <!-- Collapsible files list -->
            <div class="du-plugin-files-box" id="files_${p.id}" style="display: none; margin-top: 6px; background: rgba(0,0,0,0.25); border-radius: 8px; padding: 10px; border: 1px solid rgba(255,255,255,0.06);">
              <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px; color: #cbd5e1;">Файлы и ассеты архива:</div>
              <div style="display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto;">
                ${fileKeys.length === 0 ? `
                  <div style="font-size: 11px; color: #64748b;">(Нет прикрепленных файлов)</div>
                ` : fileKeys.map(fk => {
                  const f = p.files[fk];
                  const sizeKb = f && f.size ? (f.size / 1024).toFixed(1) + ' KB' : '0 KB';
                  return `
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; font-family: monospace; padding: 3px 6px; border-radius: 4px; background: rgba(255,255,255,0.03);">
                      <span>${fk === p.entryFile ? '⚡ ' : '📄 '}${escapeHtml(fk)}</span>
                      <span style="color: #64748b; font-size: 10.5px;">${f && f.isBinary ? 'Binary • ' : ''}${sizeKb}</span>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
          `;
        }).join('')}
      </div>

      <!-- Install Plugin from ZIP -->
      <div class="du-native-add-box du-zip-dropzone" style="margin-top: 14px; border: 2px dashed rgba(255,255,255,0.2); border-radius: 12px; padding: 22px 16px; text-align: center; cursor: pointer; transition: all 0.2s ease;">
        <input type="file" class="du-zip-file-input" accept=".zip" style="display: none;" />
        <div style="display: flex; justify-content: center; margin-bottom: 8px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
        </div>
        <div style="font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary, #f1f5f9);">
          Перетащите сюда ZIP-архив с плагином или нажмите для выбора
        </div>
        <div style="font-size: 12px; color: var(--dsw-alias-label-tertiary, #94a3b8); margin-top: 5px;">
          Поддерживаются многофайловые скрипты, манифест <code>plugin.json</code> и ассеты (CSS, HTML, изображения, JSON).
        </div>
        <div class="du-zip-status" style="font-size: 12px; margin-top: 10px; font-weight: 500; display: none;"></div>
      </div>
    </div>
  `;

  // Bind Context Limit Pills & Input
  const limitInput = panel.querySelector('.du-custom-limit-input');
  const limitStatus = panel.querySelector('.du-limit-status');
  const showSaved = () => {
    if (limitStatus) {
      limitStatus.style.display = 'inline';
      setTimeout(() => { limitStatus.style.display = 'none'; }, 2000);
    }
  };

  panel.querySelectorAll('.du-limit-pill').forEach(btn => {
    btn.onclick = () => {
      const val = parseInt(btn.getAttribute('data-val'), 10);
      setContextLimit(val);
      if (limitInput) limitInput.value = val;
      panel.querySelectorAll('.du-limit-pill').forEach(p => {
        const pVal = parseInt(p.getAttribute('data-val'), 10);
        p.style.border = pVal === val ? '1px solid #3b82f6' : '1px solid rgba(255,255,255,0.1)';
        p.style.background = pVal === val ? 'rgba(59,130,246,0.2)' : 'rgba(0,0,0,0.2)';
        p.style.color = pVal === val ? '#60a5fa' : 'inherit';
        p.style.fontWeight = pVal === val ? '600' : '400';
      });
      showSaved();
    };
  });

  if (limitInput) {
    limitInput.onchange = () => {
      const val = Math.max(0, parseInt(limitInput.value, 10) || 0);
      setContextLimit(val);
      showSaved();
    };
  }

  // Bind Plugin Toggles
  panel.querySelectorAll('input[type="checkbox"][data-plugin-id]').forEach(chk => {
    chk.onchange = () => {
      const pid = chk.getAttribute('data-plugin-id');
      const allPlugins = getStoredPlugins();
      const p = allPlugins.find(item => item.id === pid);
      if (p) {
        p.enabled = chk.checked;
        saveStoredPlugins(allPlugins);
        reloadAllPlugins();
        renderNativeConfigContent();
      }
    };
  });

  // Toggle Files View
  panel.querySelectorAll('.du-toggle-files-btn').forEach(btn => {
    btn.onclick = () => {
      const pid = btn.getAttribute('data-plugin-id');
      const box = panel.querySelector(`#files_${pid}`);
      if (box) {
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
      }
    };
  });

  // Delete Plugin
  panel.querySelectorAll('.du-native-del-btn[data-del-plugin]').forEach(btn => {
    btn.onclick = () => {
      const pid = btn.getAttribute('data-del-plugin');
      let allPlugins = getStoredPlugins();
      const p = allPlugins.find(item => item.id === pid);
      if (!confirm(`Удалить плагин "${p ? p.name : pid}"?`)) return;
      allPlugins = allPlugins.filter(item => item.id !== pid);
      saveStoredPlugins(allPlugins);
      reloadAllPlugins();
      renderNativeConfigContent();
    };
  });

  // ZIP Drag & Drop / Upload
  const dropzone = panel.querySelector('.du-zip-dropzone');
  const zipInput = panel.querySelector('.du-zip-file-input');
  const zipStatus = panel.querySelector('.du-zip-status');

  const setStatus = (msg, isError = false) => {
    if (!zipStatus) return;
    zipStatus.style.display = 'block';
    zipStatus.style.color = isError ? '#ef4444' : '#10b981';
    zipStatus.textContent = msg;
  };

  const handleZipFile = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setStatus('Ошибка: выберите архив с расширением .zip', true);
      return;
    }
    try {
      setStatus('Распаковка архива и проверка плагина...');
      const ab = await file.arrayBuffer();
      const installed = await duInstallPluginFromZip(ab, file.name);
      setStatus(`✓ Плагин "${installed.name}" успешно установлен!`);
      setTimeout(() => renderNativeConfigContent(), 800);
    } catch (err) {
      console.error('[DeepUpgrade ZIP Install Error]', err);
      setStatus(`Ошибка установки: ${err.message}`, true);
    }
  };

  if (dropzone && zipInput) {
    dropzone.onclick = (e) => {
      if (e.target !== zipInput) zipInput.click();
    };

    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#3b82f6';
      dropzone.style.background = 'rgba(59,130,246,0.1)';
    };

    dropzone.ondragleave = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'rgba(255,255,255,0.2)';
      dropzone.style.background = 'transparent';
    };

    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'rgba(255,255,255,0.2)';
      dropzone.style.background = 'transparent';
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleZipFile(file);
    };

    zipInput.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      handleZipFile(file);
      zipInput.value = '';
    };
  }

  // Load Sample Plugin Button
  const sampleBtn = panel.querySelector('.du-load-sample-plugin-btn');
  if (sampleBtn) {
    sampleBtn.onclick = () => {
      const samplePlugin = {
        id: 'plug_calc_sample',
        name: 'calc_pro',
        version: '1.0.0',
        desc: 'Математический калькулятор с ассетом справки (help.json)',
        entryFile: 'index.js',
        code: `// Калькулятор с загрузкой ассета справки
const helpData = JSON.parse(DeepUpgrade.getAsset('help.json') || '{}');

DeepUpgrade.registerTool({
  name: "calc",
  description: "Вычисляет математическое выражение в браузере или возвращает справку. Аргументы: { expr: string }",
  execute: async (args) => {
    const expr = args.expr || args.command || args.expression || '';
    if (!expr || expr === 'help') {
      return "Справка по калькулятору (из help.json):\\n" + JSON.stringify(helpData, null, 2);
    }
    try {
      const res = Function('"use strict"; return (' + expr + ')')();
      return "Результат: " + res;
    } catch(err) {
      return "Ошибка вычисления: " + err.message;
    }
  }
});`,
        files: {
          'plugin.json': {
            name: 'plugin.json',
            size: 140,
            isBinary: false,
            text: JSON.stringify({
              name: 'calc_pro',
              version: '1.0.0',
              description: 'Математический калькулятор с ассетом справки (help.json)',
              main: 'index.js'
            }, null, 2)
          },
          'index.js': {
            name: 'index.js',
            size: 750,
            isBinary: false,
            text: `// Калькулятор с загрузкой ассета справки
const helpData = JSON.parse(DeepUpgrade.getAsset('help.json') || '{}');

DeepUpgrade.registerTool({
  name: "calc",
  description: "Вычисляет математическое выражение в браузере или возвращает справку. Аргументы: { expr: string }",
  execute: async (args) => {
    const expr = args.expr || args.command || args.expression || '';
    if (!expr || expr === 'help') {
      return "Справка по калькулятору (из help.json):\\n" + JSON.stringify(helpData, null, 2);
    }
    try {
      const res = Function('"use strict"; return (' + expr + ')')();
      return "Результат: " + res;
    } catch(err) {
      return "Ошибка вычисления: " + err.message;
    }
  }
});`
          },
          'help.json': {
            name: 'help.json',
            size: 180,
            isBinary: false,
            text: JSON.stringify({
              operators: ['+', '-', '*', '/', '%', '**'],
              functions: ['Math.sqrt', 'Math.sin', 'Math.cos', 'Math.pow'],
              examples: ['2 * (10 + 5)', 'Math.sqrt(256)', '2 ** 8']
            }, null, 2)
          }
        },
        enabled: true,
        createdAt: Date.now()
      };

      const allPlugins = getStoredPlugins();
      const existingIdx = allPlugins.findIndex(p => p.id === samplePlugin.id || p.name === samplePlugin.name);
      if (existingIdx !== -1) {
        allPlugins[existingIdx] = samplePlugin;
      } else {
        allPlugins.push(samplePlugin);
      }
      saveStoredPlugins(allPlugins);
      reloadAllPlugins();
      duMountPluginToVfs(samplePlugin);
      renderNativeConfigContent();
    };
  }
}

function renderNativeSkillsContent() {
  const contentArea = document.querySelector('.ds-scroll-area__content._2db4123');
  if (!contentArea) return;

  // Hide original settings items (Theme, Language, Voice)
  Array.from(contentArea.children).forEach(ch => {
    if (!ch.classList.contains('du-native-skills-panel')) {
      ch.style.display = 'none';
    }
  });

  let panel = contentArea.querySelector('.du-native-skills-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'du-native-skills-panel';
    contentArea.appendChild(panel);
  }

  const all = getAllSkills();
  let listHtml = '';

  if (all.length === 0) {
    listHtml = `
      <div class="du-skills-empty-state">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 17L12 22L22 17" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="du-empty-text">Нет установленных скиллов</div>
        <div class="du-empty-hint">Добавьте ссылку на SKILL.md, загрузите файл или вставьте текст ниже</div>
      </div>
    `;
  } else {
    listHtml = all.map(skill => {
      const isChecked = activeSkills.includes(skill.id);
      return `
        <div class="du-native-skill-row">
          <div class="du-native-skill-info">
            <div class="du-native-skill-title">
              <svg class="du-skill-svg-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8.5 1.5L2.5 9H7.5L6.5 14.5L13.5 7H8.5L9.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span class="du-skill-main-name">${escapeHtml(skill.name)}</span>
            </div>
            <div class="du-native-skill-desc">${escapeHtml(skill.desc)}</div>
            <div class="du-native-prompt-box">${escapeHtml(skill.prompt)}</div>
          </div>
          <div class="du-native-skill-controls">
            <label class="du-switch">
              <input type="checkbox" data-skill-id="${skill.id}" ${isChecked ? 'checked' : ''}>
              <span class="du-slider"></span>
            </label>
            <button class="du-native-del-btn" data-delete-id="${skill.id}" title="Удалить скилл">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  panel.innerHTML = `
    <div class="du-native-skills-container">
      <div class="du-native-header-row">
        <div>
          <div class="du-native-title">Agent Skills</div>
          <div class="du-native-sub">Управление навыками агента (SKILL.md)</div>
        </div>
        <span class="du-native-badge">${activeSkills.length} активно</span>
      </div>

      <div class="du-native-skills-list">
        ${listHtml}
      </div>

      <div class="du-native-add-box">
        <div class="du-native-add-header">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3v10M3 8h10"/>
          </svg>
          <span class="du-native-add-title">Установка скилла</span>
        </div>
        
        <div class="du-smart-import-area">
          <div class="du-input-with-action">
            <div class="du-input-wrapper">
              <svg class="du-input-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="8" cy="8" r="6"/>
                <path d="M2 8h12M8 2a9.9 9.9 0 013 6 9.9 9.9 0 01-3 6 9.9 9.9 0 01-3-6 9.9 9.9 0 013-6z"/>
              </svg>
              <input class="du-input du-smart-url" placeholder="Вставьте ссылку на GitHub / Gist SKILL.md..." />
            </div>
            <button class="du-btn-primary du-fetch-url-btn" type="button">Загрузить</button>
          </div>
          
          <div class="du-drop-divider"><span>или загрузите файл</span></div>

          <div class="du-file-dropzone" id="duSkillDropzone">
            <input type="file" id="duSkillFileInput" accept=".md,.txt,.yaml" style="display: none;" />
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
            </svg>
            <span class="du-dropzone-text">Перетащите <b>SKILL.md</b> сюда или <a href="#" class="du-browse-link">выберите файл</a></span>
          </div>

          <textarea class="du-textarea du-smart-raw" placeholder="Или вставьте содержимое SKILL.md / YAML напрямую сюда..." rows="3"></textarea>

          <button class="du-btn-install du-submit-skill-btn" type="button">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 2v9M4 7l4 4 4-4M2 14h12"/>
            </svg>
            <span>Установить скилл</span>
          </button>
        </div>
      </div>
    </div>
  `;

  // Bind toggles
  panel.querySelectorAll('input[type="checkbox"]').forEach(chk => {
    chk.onchange = () => {
      const sid = chk.getAttribute('data-skill-id');
      if (chk.checked) {
        if (!activeSkills.includes(sid)) activeSkills.push(sid);
      } else {
        activeSkills = activeSkills.filter(id => id !== sid);
      }
      localStorage.setItem('du_active_skills', JSON.stringify(activeSkills));
      publishDirectiveToMainWorld(true);
      renderNativeSkillsContent();
    };
  });

  // Delete
  panel.querySelectorAll('.du-native-del-btn').forEach(btn => {
    btn.onclick = () => {
      const idToDel = btn.getAttribute('data-delete-id');
      customSkills = customSkills.filter(s => s.id !== idToDel);
      activeSkills = activeSkills.filter(id => id !== idToDel);
      localStorage.setItem('du_custom_skills', JSON.stringify(customSkills));
      localStorage.setItem('du_active_skills', JSON.stringify(activeSkills));
      publishDirectiveToMainWorld(true);
      renderNativeSkillsContent();
    };
  });

  // Smart URL fetch
  const fetchUrlBtn = panel.querySelector('.du-fetch-url-btn');
  const urlInput = panel.querySelector('.du-smart-url');
  const rawTextarea = panel.querySelector('.du-smart-raw');

  if (fetchUrlBtn && urlInput) {
    fetchUrlBtn.onclick = async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      fetchUrlBtn.innerText = 'Загрузка...';
      try {
        const resp = await fetch(url);
        const text = await resp.text();
        rawTextarea.value = text;
        fetchUrlBtn.innerText = 'Успешно';
        setTimeout(() => { fetchUrlBtn.innerText = 'Загрузить'; }, 1500);
      } catch (e) {
        alert('Ошибка загрузки: ' + e.message);
        fetchUrlBtn.innerText = 'Ошибка';
      }
    };
  }

  // File Drop / Browse
  const dropzone = panel.querySelector('#duSkillDropzone');
  const fileInput = panel.querySelector('#duSkillFileInput');
  const browseLink = panel.querySelector('.du-browse-link');

  if (browseLink && fileInput) {
    browseLink.onclick = (e) => {
      e.preventDefault();
      fileInput.click();
    };
  }

  if (fileInput) {
    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          rawTextarea.value = ev.target.result;
        };
        reader.readAsText(file);
      }
    };
  }

  if (dropzone) {
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
    dropzone.ondragleave = () => { dropzone.classList.remove('dragover'); };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          rawTextarea.value = ev.target.result;
        };
        reader.readAsText(file);
      }
    };
  }

  // Submit Skill (Auto-parses YAML or Markdown)
  const submitBtn = panel.querySelector('.du-submit-skill-btn');
  if (submitBtn) {
    submitBtn.onclick = () => {
      const raw = rawTextarea.value.trim();
      if (!raw) {
        alert('Пожалуйста, укажите ссылку, выберите файл или вставьте текст SKILL.md!');
        return;
      }

      const parsed = parseSkillMarkdown(raw);
      const existingIndex = customSkills.findIndex(item => item.name && item.name.trim().toLowerCase() === parsed.name.trim().toLowerCase());
      let skillId;
      if (existingIndex >= 0) {
        skillId = customSkills[existingIndex].id;
        customSkills[existingIndex] = {
          id: skillId,
          name: parsed.name,
          desc: parsed.desc,
          prompt: parsed.prompt
        };
      } else {
        skillId = 'custom_' + Date.now().toString(36);
        customSkills.push({
          id: skillId,
          name: parsed.name,
          desc: parsed.desc,
          prompt: parsed.prompt
        });
      }
      if (!activeSkills.includes(skillId)) activeSkills.push(skillId);

      localStorage.setItem('du_custom_skills', JSON.stringify(customSkills));
      localStorage.setItem('du_active_skills', JSON.stringify(activeSkills));
      syncSkillsToVfs();
      publishDirectiveToMainWorld(true);
      renderNativeSkillsContent();
    };
  }
}

// Inject 1:1 Native "Agent" Toggle Button next to DeepThink and Search
function injectAgentToggleButton() {
  const toggleBar = document.querySelector('div._58b31c9');
  if (!toggleBar || toggleBar.querySelector('.du-agent-toggle-btn')) return;

  const btn = document.createElement('div');
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('role', 'button');
  btn.className = `f79352dc ds-toggle-button ds-toggle-button--m du-agent-toggle-btn ${isAgentEnabled ? 'ds-toggle-button--selected' : ''}`;
  btn.setAttribute('aria-pressed', isAgentEnabled ? 'true' : 'false');
  btn.style.transform = 'translateZ(0px)';

  btn.innerHTML = `
    <div class="ds-toggle-button__icon">
      <div class="ds-icon" style="font-size: inherit;">
        <div class="ds-lottie-toggle-icon" aria-hidden="true">
          <div style="width: 14px; height: 14px;">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8.5 1.5L2.5 9H7.5L6.5 14.5L13.5 7H8.5L9.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
    <span class="_6dbc175">Agent</span>
    <div class="ds-focus-ring" style="--dsl-focus-ring-offset: -1px;"></div>
  `;

  let currentTooltipWrapper = null;

  btn.onmouseenter = () => {
    let container = document.querySelector('div.ds-floating-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ds-floating-container';
      container.style.zIndex = '1024';
      document.body.appendChild(container);
    }

    const rect = btn.getBoundingClientRect();
    const wrapper = document.createElement('div');
    wrapper.className = 'ds-floating-position-wrapper ds-theme';
    wrapper.setAttribute('data-transform-origin', 'bottom');
    wrapper.style.position = 'fixed';
    wrapper.style.zIndex = '1024';
    wrapper.style.pointerEvents = 'none';

    wrapper.innerHTML = `
      <div class="du-native-tooltip">
        Autonomous tools, sandbox &amp; skills execution
      </div>
    `;

    container.appendChild(wrapper);
    currentTooltipWrapper = wrapper;

    const tipRect = wrapper.getBoundingClientRect();
    const left = rect.left + rect.width / 2 - tipRect.width / 2;
    const top = rect.top - tipRect.height - 6;

    wrapper.style.left = `${Math.round(left)}px`;
    wrapper.style.top = `${Math.round(top)}px`;
  };

  btn.onmouseleave = () => {
    if (currentTooltipWrapper) {
      currentTooltipWrapper.remove();
      currentTooltipWrapper = null;
    }
  };

  btn.onclick = () => {
    const next = !(typeof window.__DU_SETTINGS__ !== 'undefined'
      ? window.__DU_SETTINGS__.isEnabled()
      : isAgentEnabled);
    if (typeof window.__DU_SETTINGS__ !== 'undefined') {
      window.__DU_SETTINGS__.setEnabled(next);
    } else {
      isAgentEnabled = next;
      localStorage.setItem('du_tools_enabled', JSON.stringify(isAgentEnabled));
    }
    syncAgentToggleButton();
  };

  toggleBar.appendChild(btn);
}

// -------------------------------------------------------------
// OpenCode Project Workspace Selector & Native Folder Importer
// -------------------------------------------------------------
let currentProjectName = localStorage.getItem('du_active_project') || null;
let knownProjects = JSON.parse(localStorage.getItem('du_known_projects') || '[]');

function openProjectDropdown(anchorBtn) {
  let existing = document.querySelector('.du-project-menu');
  if (existing) {
    existing.remove();
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'du-project-menu';

  const renderItems = (filterText = '') => {
    const filtered = knownProjects.filter(p => p.toLowerCase().includes(filterText.toLowerCase()));

    let projectsHtml = filtered.map(name => {
      const isCur = name === currentProjectName;
      return `
        <button class="du-menu-item ${isCur ? 'active' : ''}" type="button" data-project="${escapeHtml(name)}">
          <svg class="du-menu-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.5L8 4H12.5C13.3284 4 14 4.67157 14 5.5V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke-linejoin="round"/>
          </svg>
          <span class="du-menu-item-label">${escapeHtml(name)}</span>
          ${isCur ? `
            <svg class="du-menu-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 8.5L6.5 11.5L12.5 4.5"/>
            </svg>
          ` : ''}
        </button>
      `;
    }).join('');

    if (filtered.length === 0) {
      projectsHtml = `<div style="padding: 8px 10px; font-size: 12px; color: #6B7280;">Ничего не найдено</div>`;
    }

    return `
      <div class="du-menu-search-wrapper">
        <svg class="du-menu-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="7" cy="7" r="4.5"/>
          <path d="M10.5 10.5L14 14" stroke-linecap="round"/>
        </svg>
        <input class="du-menu-search-input" placeholder="Search projects or devices" value="${escapeHtml(filterText)}" />
      </div>
      <div class="du-menu-projects-list">
        ${projectsHtml}
      </div>
      <div class="du-menu-divider"></div>
      <button class="du-menu-item du-action-create" type="button">
        <svg class="du-menu-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.5L8 4H12.5C13.3284 4 14 4.67157 14 5.5V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke-linejoin="round"/>
          <path d="M8 7v4M6 9h4" stroke-linecap="round"/>
        </svg>
        <span class="du-menu-item-label">Create project</span>
      </button>
      <button class="du-menu-item du-action-outside" type="button">
        <svg class="du-menu-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <circle cx="8" cy="8" r="6"/>
          <path d="M5 8h6" stroke-linecap="round"/>
        </svg>
        <span class="du-menu-item-label">Work outside a project</span>
      </button>
    `;
  };

  menu.innerHTML = renderItems();

  const bindEvents = () => {
    const searchInput = menu.querySelector('.du-menu-search-input');
    searchInput?.focus();
    searchInput?.addEventListener('input', (e) => {
      const listEl = menu.querySelector('.du-menu-projects-list');
      const val = e.target.value;
      const filtered = knownProjects.filter(p => p.toLowerCase().includes(val.toLowerCase()));
      if (listEl) {
        if (filtered.length === 0) {
          listEl.innerHTML = `<div style="padding: 8px 10px; font-size: 12px; color: #6B7280;">Ничего не найдено</div>`;
        } else {
          listEl.innerHTML = filtered.map(name => {
            const isCur = name === currentProjectName;
            return `
              <button class="du-menu-item ${isCur ? 'active' : ''}" type="button" data-project="${escapeHtml(name)}">
                <svg class="du-menu-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.5L8 4H12.5C13.3284 4 14 4.67157 14 5.5V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke-linejoin="round"/>
                </svg>
                <span class="du-menu-item-label">${escapeHtml(name)}</span>
                ${isCur ? `
                  <svg class="du-menu-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3.5 8.5L6.5 11.5L12.5 4.5"/>
                  </svg>
                ` : ''}
              </button>
            `;
          }).join('');
        }
      }
    });

    menu.addEventListener('click', (e) => {
      const projBtn = e.target.closest('[data-project]');
      if (projBtn) {
        const chosen = projBtn.getAttribute('data-project');
        currentProjectName = chosen;
        localStorage.setItem('du_active_project', currentProjectName);
        const nameEl = document.querySelector('.du-project-name');
        if (nameEl) nameEl.innerText = currentProjectName;
        menu.remove();
        return;
      }

      if (e.target.closest('.du-action-create')) {
        menu.remove();
        const fileInput = document.querySelector('.du-project-folder-input');
        fileInput?.click();
        return;
      }

      if (e.target.closest('.du-action-outside')) {
        currentProjectName = null;
        localStorage.removeItem('du_active_project');
        const nameEl = document.querySelector('.du-project-name');
        if (nameEl) nameEl.innerText = 'No Project';
        menu.remove();
        return;
      }
    });
  };

  bindEvents();

  const closeHandler = (e) => {
    if (!menu.contains(e.target) && !anchorBtn.contains(e.target)) {
      menu.remove();
      document.removeEventListener('pointerdown', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeHandler), 10);

  anchorBtn.parentElement.appendChild(menu);
}

// <du-project-plate>
// Resolve the outer composer card: the element that actually paints the rounded
// input surface, not the transparent wrappers inside it.
//
// Empty chats match `div._77cefa5._9996a53`. As soon as the chat has messages
// DeepSeek swaps the modifier class (e.g. `_3d616d3`), the old selector stops
// matching and the previous fallback `closest('div:has(textarea)')` returned an
// inner transparent wrapper *inside* the card. The plate was then injected
// inside the rounded card, so the card painted its own border and corners
// around it and the plate looked like a second, crooked pill.
function findComposerCard(input) {
  let start = input;
  if (!start) {
    start = typeof findDeepSeekInput === 'function' ? findDeepSeekInput() : null;
  }
  if (!start) return null;
  if (start.closest && start.closest('[role="dialog"], .ds-modal, .du-native-skills-panel, .du-native-files-panel, .du-native-config-panel')) {
    return null;
  }
  if (!start.matches || !start.matches('textarea, input, [contenteditable="true"]')) {
    start = start.querySelector('textarea, input, [contenteditable="true"]') || start;
  }

  const known = start.closest('div._77cefa5._9996a53') || start.closest('div._77cefa5');
  if (known) return known;

  // Class names are obfuscated and can change: fall back to the nearest ancestor
  // that looks like a card (rounded + painted), then to a rounded wrapper.
  let el = start.parentElement;
  let roundedOnly = null;
  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    if (el.closest && el.closest('[role="dialog"], .ds-modal, .du-native-skills-panel, .du-native-files-panel, .du-native-config-panel')) {
      return null;
    }
    const cs = window.getComputedStyle(el);
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius < 12) continue;
    const bg = cs.backgroundColor;
    const painted = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    if (painted) return el;
    if (!roundedOnly) roundedOnly = el;
  }
  return roundedOnly || start.closest('div:has(textarea)');
}

function syncProjectBarGeometry(bar, card) {
  if (!bar || !card || !bar.isConnected || !card.isConnected) return;

  const apply = () => {
    if (!bar.isConnected || !card.isConnected) return;
    if (bar.__duSyncScheduled) return;
    bar.__duSyncScheduled = true;

    // Coalesce bursts of DOM mutations (streaming answers trigger many).
    requestAnimationFrame(() => {
      bar.__duSyncScheduled = false;
      if (!bar.isConnected || !card.isConnected) return;

      const cardRect = card.getBoundingClientRect();
      if (cardRect.width <= 0) return;

      // The plate must be exactly as wide as the native card. A wider plate is
      // what turned the top bar into a flat dark strip in populated chats.
      const nextWidth = Math.round(cardRect.width) + 'px';
      if (bar.style.width !== nextWidth) {
        bar.style.setProperty('width', nextWidth, 'important');
      }

      const barRect = bar.getBoundingClientRect();
      const currentLeft = parseFloat(bar.style.left) || 0;
      // barRect already includes the current relative offset, so add the delta.
      const nextLeft = Math.round(currentLeft + (cardRect.left - barRect.left)) + 'px';
      if (bar.style.left !== nextLeft) {
        bar.style.setProperty('left', nextLeft, 'important');
      }

      const cs = window.getComputedStyle(card);
      const radius = parseFloat(cs.borderTopLeftRadius);
      const nextRadius = (Number.isFinite(radius) && radius > 0 ? radius : 20) + 'px';
      if (bar.style.getPropertyValue('--du-plate-radius') !== nextRadius) {
        bar.style.setProperty('--du-plate-radius', nextRadius);
      }

      // Do NOT copy the card's border color: when the composer is focused
      // DeepSeek paints its border violet, and copying it turned the whole
      // project plate into a bright purple outline in existing chats.
    });
  };

  apply();

  if (window.ResizeObserver) {
    if (bar.__duPlateObserver && bar.__duPlateCard === card) return;
    if (bar.__duPlateObserver) bar.__duPlateObserver.disconnect();
    const observer = new ResizeObserver(apply);
    observer.observe(card);
    bar.__duPlateObserver = observer;
    bar.__duPlateCard = card;
  }
}
// </du-project-plate>

function injectProjectSelector() {
  // Purge any rogue plates that leaked into modal dialogs or settings panels
  document.querySelectorAll('[role="dialog"] .du-project-top-bar, .du-native-config-panel .du-project-top-bar, .du-native-skills-panel .du-project-top-bar, .du-native-files-panel .du-project-top-bar').forEach((node) => node.remove());

  const card = findComposerCard();
  if (!card) return;

  const parent = card.parentElement;
  if (!parent) return;

  // Drop plates left behind in another container (an older build injected the
  // plate inside the composer card, which is what produced the seam).
  document.querySelectorAll('.du-project-top-bar').forEach((node) => {
    if (node.parentElement !== parent) node.remove();
  });

  // Check if project plate already exists inside this container
  let bar = parent.querySelector(':scope > .du-project-top-bar');
  if (bar) {
    // React can reorder the composer; keep the plate glued right above it.
    if (bar.nextElementSibling !== card) parent.insertBefore(bar, card);
    syncProjectBarGeometry(bar, card);
    return;
  }

  bar = document.createElement('div');
  bar.className = 'du-project-top-bar';
  bar.innerHTML = `
    <button class="du-project-select-btn" type="button" title="Выбрать активный проект">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.5L8 4H12.5C13.3284 4 14 4.67157 14 5.5V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      </svg>
      <span class="du-project-name">${escapeHtml(currentProjectName || 'Select project...')}</span>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>
    <button class="du-project-add-btn" type="button" title="Открыть папку с диска в VFS">+</button>
    <input type="file" class="du-project-folder-input" webkitdirectory directory multiple style="display: none;">
  `;

  const selectBtn = bar.querySelector('.du-project-select-btn');
  selectBtn.onclick = (e) => {
    e.stopPropagation();
    openProjectDropdown(selectBtn);
  };

  const addBtn = bar.querySelector('.du-project-add-btn');
  const fileInput = bar.querySelector('.du-project-folder-input');
  addBtn.onclick = () => fileInput.click();
  fileInput.onchange = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const firstRel = files[0].webkitRelativePath || '';
    const folderName = firstRel.split('/')[0] || 'Project';
    currentProjectName = folderName;
    if (!knownProjects.includes(folderName)) {
      knownProjects.push(folderName);
      localStorage.setItem('du_known_projects', JSON.stringify(knownProjects));
    }
    localStorage.setItem('du_active_project', currentProjectName);
    bar.querySelector('.du-project-name').innerText = currentProjectName;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.webkitRelativePath.includes('/.git/') || file.webkitRelativePath.includes('/node_modules/')) continue;
      const vfsPath = '/' + file.webkitRelativePath;
      try {
        const text = await file.text();
        if (sandboxIframe && sandboxIframe.contentWindow) {
          sandboxIframe.contentWindow.postMessage({
            type: 'DU_STORE_ATTACHMENT',
            path: vfsPath,
            data: text,
            isBinary: false,
            mtime: file.lastModified
          }, '*');
        }
      } catch (err) {
        console.warn('[DeepUpgrade Project] Не удалось прочитать файл:', file.name, err);
      }
    }
  };

  // Safe DOM placement: insert directly before card without reparenting or stealing nodes from React!
  // Set the width before insertion so the plate never flashes at content width.
  const initialRect = card.getBoundingClientRect();
  if (initialRect.width > 0) {
    bar.style.setProperty('width', Math.round(initialRect.width) + 'px', 'important');
  }
  parent.insertBefore(bar, card);
  syncProjectBarGeometry(bar, card);
}


// -------------------------------------------------------------
// Sidebar "New Project" Button
// -------------------------------------------------------------
function injectNewProjectButton() {
  if (document.querySelector('.du-new-project-btn')) return;

  let newChatBtn = null;
  const allBtns = document.querySelectorAll('div[tabindex="0"], a, button');
  for (const el of allBtns) {
    if (el.textContent && el.textContent.trim().toLowerCase().includes('new chat')) {
      newChatBtn = el;
      break;
    }
  }

  if (!newChatBtn) return;

  // The wrapper of the new chat button is div.dc1f7bee._4bcc731
  // Its parent div._7b40dad is a container with fixed geometry!
  const newChatWrapper = newChatBtn.closest('.dc1f7bee') || newChatBtn.parentElement;
  if (!newChatWrapper) return;

  const topSection = newChatWrapper.parentElement; // div._7b40dad
  if (!topSection || !topSection.parentElement) return;

  if (topSection.parentElement.querySelector('.du-new-project-container')) return;

  // Create an identical top-level container to place AFTER div._7b40dad
  const projContainer = document.createElement('div');
  projContainer.className = (topSection.className || '_7b40dad') + ' du-new-project-container';
  projContainer.style.cssText = 'margin-top: 6px !important; margin-bottom: 4px !important; width: 100% !important; box-sizing: border-box !important;';

  const projWrapper = document.createElement('div');
  projWrapper.className = newChatWrapper.className || 'dc1f7bee _4bcc731';
  projWrapper.style.cssText = 'width: 100% !important; box-sizing: border-box !important;';

  const btn = document.createElement('div');
  const cleanClass = (newChatBtn.className || '_5a8ac7a')
    .split(/\s+/)
    .filter(c => c && !c.includes('a084f19e'))
    .join(' ');
  btn.className = (cleanClass || '_5a8ac7a') + ' du-new-project-btn';
  btn.setAttribute('tabindex', '0');
  btn.style.cssText = 'justify-content: center; cursor: pointer; box-sizing: border-box;';

  btn.innerHTML = `
    <div class="ds-icon _1c42ad7" style="font-size: 16px; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.5L8 4H12.5C13.3284 4 14 4.67157 14 5.5V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        <path d="M8 7V11M6 9H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
    </div>
    <span style="margin-left: 8px; font-weight: 500;">New project</span>
    <span class="du-new-project-badge">Alt + P</span>
    <div class="ds-focus-ring"></div>
  `;

  btn.onclick = (e) => {
    e.stopPropagation();
    const folderInput = document.querySelector('.du-project-folder-input');
    if (folderInput) {
      folderInput.click();
    } else {
      const projBtn = document.querySelector('.du-project-select-btn');
      if (projBtn) projBtn.click();
    }
  };

  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      btn.click();
    }
  });

  // Global Alt+P shortcut handler
  if (!window.__du_alt_p_bound) {
    window.__du_alt_p_bound = true;
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) {
        e.preventDefault();
        e.stopPropagation();
        const activeBtn = document.querySelector('.du-new-project-btn');
        if (activeBtn) activeBtn.click();
      }
    }, true);
  }

  projWrapper.appendChild(btn);
  projContainer.appendChild(projWrapper);
  topSection.parentElement.insertBefore(projContainer, topSection.nextSibling);
}

const observer = new MutationObserver(() => {
  checkSessionChange();
  cleanAndUnifyChat();
  hookInput();
  hookAttachmentElements();
  processToolCalls();
  watchComposerSend();
  // The durable store may hold files the model should know about.
  refreshStoreAssets().then(() => publishDirectiveToMainWorld(false));
  injectSkillsSettingsButton();
  injectAgentToggleButton();
  injectProjectSelector();
  injectNewProjectButton();
});

observer.observe(document.documentElement, { childList: true, subtree: true });

// History must never be re-executed just because the page was reloaded.
seedHistoricalExecutions();
cleanAndUnifyChat();
hookInput();
hookAttachmentElements();
processToolCalls();
injectSkillsSettingsButton();
injectAgentToggleButton();
injectNewProjectButton();
runAttachmentCleanup();
// Publish the directive for the MAIN-world interceptor (skill list + assets).
publishDirectiveToMainWorld(true);
