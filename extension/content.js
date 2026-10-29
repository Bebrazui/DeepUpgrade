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
      const out = [];
      const walk = async (dirHandle, prefix) => {
        for await (const [name, handle] of dirHandle.entries()) {
          const path = `${prefix}/${name}`;
          if (handle.kind === 'file') {
            try {
              const file = await handle.getFile();
              out.push({ path, content: await file.text(), mtime: file.lastModified || Date.now() });
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

    async dirFor(path, create) {
      const parts = splitPath(path);
      const fileName = parts.pop();
      let dir = this.root;
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: !!create });
      }
      return { dir, fileName };
    }

    async writeFile(path, content) {
      const text = typeof content === 'string' ? content : String(content ?? '');
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_FILE_BYTES) {
        throw new Error(`file is larger than ${MAX_FILE_BYTES} bytes and was not persisted`);
      }
      await this.init();
      if (this.mode !== 'opfs') {
        this.memory.set(path, { path, content: text, mtime: Date.now() });
        return;
      }
      const { dir, fileName } = await this.dirFor(path, true);
      const handle = await dir.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
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

    apply(message) {
      const { op, path, content } = message || {};
      if (!path) return Promise.resolve({ ok: false, error: 'missing path' });
      const normalized = '/' + splitPath(path).join('/');
      return this.enqueue(async () => {
        try {
          if (op === 'write') {
            await this.writeFile(normalized, content);
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

function buildSystemDirective() {
  const all = getAllSkills();
  const enabled = all.filter(s => activeSkills.includes(s.id));
  let skillsSection = '';
  if (enabled.length > 0) {
    skillsSection = `\n\n[AVAILABLE SKILLS (Loaded in VFS)]:\n` + enabled.map(s => {
      const slug = getSkillSlug(s.name);
      return `- ${s.name}: ${s.desc || s.name} (Rules: /skills/${slug}/SKILL.md)`;
    }).join('\n');
  }

  // Detect whether running in Desktop environment with real OS terminal
  let envHeader = `You have direct access to a high-performance in-browser WebAssembly POSIX sandbox:
- Isolated Virtual File System (VFS mounted at root '/')
- POSIX Shell with core utilities & network access (curl, fetch)
- Python 3.12 (Pyodide WASM runtime with standard libraries)
- JavaScript / Node-compatible async executor`;

  if (window.__DU_DESKTOP__ && window.__DU_DESKTOP__.isDesktop) {
    const desktopCfg = (typeof window.__DU_DESKTOP_CONFIG__ === 'object' && window.__DU_DESKTOP_CONFIG__) || {};
    const shellInfo = desktopCfg.shell || { name: 'PowerShell / System Terminal', type: 'powershell' };
    const isPowershell = shellInfo.type === 'powershell' || shellInfo.id === 'powershell' || shellInfo.id === 'pwsh';

    envHeader = `You have DIRECT NATIVE ACCESS to the host computer operating system:
- Current OS: Windows NT x86_64
- Configured Native Shell: ${shellInfo.name} (${shellInfo.path || shellInfo.id})
- Active Working Directory: Local PC Filesystem
${isPowershell ? '- IMPORTANT FOR TERMINAL: Use native PowerShell / Windows commands (e.g. Get-ComputerInfo, dir, Get-ChildItem, systeminfo, hostname). Do NOT use Linux-specific flags like "ls -la" (use "dir" or "Get-ChildItem").' : '- IMPORTANT FOR TERMINAL: Use POSIX bash commands.'}`;
  }

  return `[SYSTEM INSTRUCTION: OPENCODE AUTONOMOUS AGENT ACTIVE]
You are DeepUpgrade, an autonomous AI software engineer and terminal runtime environment powered by OpenCode architecture.
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
      const text = await resp.text();
      let headersObj = {};
      resp.headers.forEach((v, k) => { headersObj[k] = v; });
      sandboxIframe.contentWindow.postMessage({
        type: 'DU_PROXY_FETCH_RESULT',
        fetchId,
        success: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: headersObj,
        data: text
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
    if (isSkillsTabActive) renderNativeSkillsContent();
  }
});

// Setup Sandbox Iframe (Universal for Chrome Extension and Android WebView)
let sandboxIframe = null;
const pendingCalls = new Map();

// --- ATTACHED ASSETS (OPFS /added/) ENGINE ---
// Maps file key / name -> { name, path, type, size, isPicture }
const stagedAttachments = new Map();

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
  if (stagedAttachments.size === 0) return '';
  const lines = [];
  for (const info of stagedAttachments.values()) {
    lines.push(`- ${info.path} (${info.type || 'application/octet-stream'}, ${formatBytes(info.size)})`);
  }
  return `\n\n[ATTACHED ASSETS AVAILABLE IN VFS]:\n${lines.join('\n')}\n(You can access or inspect these files in python, js, or shell tools)`;
}

window.__DU_GET_SYSTEM_DIRECTIVE__ = function() {
  return `${buildSystemDirective()}${buildAttachedAssetsDirective()}`;
};

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
    syncSkillsToVfs();
    // Send persistent packages to sandbox
    const savedPackages = JSON.parse(localStorage.getItem('du_persistent_packages') || '[]');
    sandboxIframe.contentWindow.postMessage({
      type: 'DU_SET_PERSISTENT_PACKAGES',
      packages: savedPackages
    }, '*');
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
      handleVfsBoot(ev);
    } else if (ev.data && ev.data.type === 'DU_VFS_MUTATE') {
      handleVfsMutation(ev, ev.data);
    }
  });
}
initSandboxIframe();

// Keep the durable VFS consistent if the tab is closed mid-write.
window.addEventListener('pagehide', () => {
  const store = duVfsStore();
  if (store) store.flush();
});

function runInSandbox(toolObj) {
  // If running in DeepUpgrade Desktop, route directly to real OS terminal & FS!
  if (window.__DU_DESKTOP__ && window.__DU_DESKTOP__.isDesktop) {
    return new Promise(async (resolve) => {
      const id = Math.random().toString(36).slice(2);
      const name = toolObj.name || toolObj.tool;
      const args = toolObj.args || {};

      try {
        if (name === 'bash' || name === 'sh' || name === 'terminal' || name === 'exec') {
          const cmd = args.command || args.cmd || toolObj.command || '';
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

        if (name === 'write_file' || name === 'create_file') {
          const path = args.path || args.filePath || '';
          const content = args.content || args.file_text || '';
          const res = await window.__DU_DESKTOP__.fs.writeFile(path, content);
          resolve({
            id,
            success: res.ok,
            output: res.ok ? `File written: ${path}` : `Write error: ${res.error}`
          });
          return;
        }

        if (name === 'read_file' || name === 'view_file') {
          const path = args.path || args.filePath || '';
          const res = await window.__DU_DESKTOP__.fs.readFile(path);
          resolve({
            id,
            success: res.ok,
            output: res.ok ? res.data : `Read error: ${res.error}`
          });
          return;
        }

        if (name === 'list_files' || name === 'ls') {
          const path = args.path || args.dirPath || '.';
          const res = await window.__DU_DESKTOP__.fs.listDir(path);
          resolve({
            id,
            success: res.ok,
            output: res.ok ? res.entries.map(e => (e.isDirectory ? '[DIR] ' : '') + e.name).join('\n') : `List error: ${res.error}`
          });
          return;
        }

        // Fallback to real terminal execution for any other command
        const fallbackCmd = args.command || args.cmd || JSON.stringify(args);
        const res = await window.__DU_DESKTOP__.terminal.exec(fallbackCmd);
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
    if (!sandboxIframe || !sandboxIframe.contentWindow) {
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
      resolve({ id, success: false, output: `Sandbox dispatch error: ${err.message}` });
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

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) || '');
    return parsed ?? fallback;
  } catch (e) {
    return fallback;
  }
}

const executedTurns = new Set(readJsonStorage(EXECUTED_KEY, []));
const executedOutputs = new Map(readJsonStorage(EXECUTED_OUTPUT_KEY, []));

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
  for (const bubble of document.querySelectorAll('.fbb737a4')) {
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
  for (const bubble of document.querySelectorAll('.fbb737a4')) {
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
  if (typeof output === 'string' && blockKey) executedOutputs.set(blockKey, output);

  if (executedTurns.size > 300) {
    [...executedTurns].slice(0, executedTurns.size - 300).forEach((oldKey) => executedTurns.delete(oldKey));
  }
  if (executedOutputs.size > 300) {
    [...executedOutputs.keys()].slice(0, executedOutputs.size - 300).forEach((oldKey) => executedOutputs.delete(oldKey));
  }

  try {
    sessionStorage.setItem(EXECUTED_KEY, JSON.stringify([...executedTurns]));
    sessionStorage.setItem(EXECUTED_OUTPUT_KEY, JSON.stringify([...executedOutputs].slice(-300)));
  } catch (e) { /* storage quota - dedupe still works in memory */ }
}
// </du-tool-dedupe>

let allowExecution = false;

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
        if (clipText && (clipText.includes('[SYSTEM CAPABILITY:') || clipText.includes('[SYSTEM INSTRUCTION:'))) {
          const cleanText = clipText.replace(/\[SYSTEM (?:CAPABILITY|INSTRUCTION):[\s\S]*?\[USER REQUEST\]:\s*/g, '');
          await navigator.clipboard.writeText(cleanText);
        }
      } catch (err) {}
    }, 50);
  }
}, true);

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

// Seamless unification & absolute stealth (Safe non-destructive mode)
function cleanAndUnifyChat() {
  preemptiveHide();

  // 1. Clean user prompts inside main chat message text nodes
  const messageNodes = document.querySelectorAll('.ds-message, div[class*="message"], .ds-collapsible-text');
  messageNodes.forEach(container => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && (node.nodeValue.includes('[SYSTEM CAPABILITY:') || node.nodeValue.includes('[SYSTEM INSTRUCTION:'))) {
        node.nodeValue = node.nodeValue.replace(/\[SYSTEM (?:CAPABILITY|INSTRUCTION):[\s\S]*?\[USER REQUEST\]:\s*/g, '');
      }
    }
  });

  // 2. Clean Right-side Minimap / Navigation items
  const minimapItems = document.querySelectorAll('div._72b6158, div._81e7b5e, div.ds-virtual-list-visible-items > div');
  minimapItems.forEach(item => {
    const text = item.innerText || '';
    if (text.includes('[SANDBOX OUTPUT') || text.includes('[USER ANSWER]:')) {
      item.style.setProperty('display', 'none', 'important');
    } else if (text.includes('[SYSTEM CAPABILITY:') || text.includes('[SYSTEM INSTRUCTION:')) {
      const targetTextNode = findTextNodeWith(item, '[SYSTEM ');
      if (targetTextNode) {
        targetTextNode.nodeValue = targetTextNode.nodeValue.replace(/\[SYSTEM (?:CAPABILITY|INSTRUCTION):[\s\S]*?\[USER REQUEST\]:\s*/g, '');
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
  const nodes = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]'));
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
  const bubbles = document.querySelectorAll('.fbb737a4');
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

        // Fallback timer if MAIN world doesn't answer in 4s
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve({ success: false, error: 'Network bridge timeout' });
        }, 4000);
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
let isAgentEnabled = JSON.parse(localStorage.getItem('du_agent_enabled') ?? 'true');

function hookInput() {
  const inputEl = findDeepSeekInput();
  if (!inputEl || inputEl.hasAttribute('data-du-hooked')) return;

  inputEl.setAttribute('data-du-hooked', 'true');

  const onSend = () => {
    const val = (inputEl.value !== undefined ? inputEl.value : inputEl.textContent || '').trim();
    if (!val || val.includes('[SYSTEM CAPABILITY:') || val.includes('[SYSTEM INSTRUCTION:') || val.startsWith('[SANDBOX OUTPUT')) return;

    if (isAgentEnabled) {
      allowExecution = true;
      const attachedDirective = buildAttachedAssetsDirective();
      
      // OpenCode Architecture: Check if this is the very first turn of the session
      // If messages already exist in chat, we do NOT spam the full 80-line system directive!
      const existingBubbles = document.querySelectorAll('.ds-message, div._9663006');
      const isFirstTurn = existingBubbles.length === 0;

      if (isFirstTurn || attachedDirective) {
        const container = inputEl.closest('form, div:has(textarea), div:has([contenteditable])') || inputEl.parentElement;
        if (container) container.classList.add('du-locked-box');
        inputEl.classList.add('du-freezing');

        const promptPrefix = isFirstTurn ? `${buildSystemDirective()}${attachedDirective}\n\n[USER REQUEST]: ` : `${attachedDirective}\n\n`;
        updateReactInput(inputEl, `${promptPrefix}${val}`);
        
        // Clear staged attachments after successful dispatch
        stagedAttachments.clear();

        // Keep lock until DeepSeek React clears input on dispatch
        setTimeout(() => {
          inputEl.classList.remove('du-freezing');
          if (container) container.classList.remove('du-locked-box');
        }, 500);
      } else {
        // Subsequent conversation turns: let user text flow naturally without expanding into a massive system prompt!
        stagedAttachments.clear();
      }
    } else {
      allowExecution = false;
      stagedAttachments.clear();
      // Plain normal message without any agent directives
    }
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

function processToolCalls() {
  cleanAndUnifyChat();

  // Find all code blocks (strictly targeting container .md-code-block or standalone pre)
  const allBlocks = Array.from(document.querySelectorAll('.md-code-block, pre'));
  if (allBlocks.length === 0) return;

  allBlocks.forEach(async block => {
   try {
    // If this is a <pre> whose parent .md-code-block is already processed, skip
    if (block.tagName.toLowerCase() === 'pre' && block.closest('.md-code-block')) {
      const parentBlock = block.closest('.md-code-block');
      if (parentBlock.hasAttribute('data-du-rendered')) return;
      block = parentBlock; // Process the parent wrapper directly
    }

    if (block.hasAttribute('data-du-rendered')) return;

    const codeText = block.innerText || '';
    const toolObj = extractToolCall(codeText);
    if (!toolObj) {
      // The answer is still streaming: show the tool card (shimmering label) as
      // soon as the tool name is readable instead of waiting for the full block.
      const partial = extractPartialToolMeta(codeText);
      if (partial) renderStreamingToolCard(block, partial);
      return;
    }

    // Never execute a block that is still streaming.
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

    const blockHash = 'du_' + codeText.replace(/\s+/g, '').slice(0, 80);
    const turnKey = getToolTurnKey(block);
    const blockKey = `${turnKey}|${blockHash}`;

    block.setAttribute('data-du-rendered', 'true');
    const toolWidget = renderOpenCode1to1(block, toolObj);

    // A malformed block must never reach the sandbox: writing an empty file and
    // reporting success is worse than showing a visible parse error.
    if (toolObj.__parseError) {
      console.warn('[DeepUpgrade] Tool parse error:', toolObj.__parseError, '\nRaw block:\n' + codeText);
      setOpenCodeOutput(toolWidget, `⚠️ ${toolObj.__parseError}\n\nИнструмент не выполнен, чтобы не повредить файлы.`);
      return;
    }

    // Auto-execution requires the user to have sent a message in this page
    // session (allowExecution). Agent mode alone must not re-run tool calls that
    // were already in chat history when the page loaded.
    const isAutoExecutionEligible = allowExecution && isAgentEnabled;

    if (!isAutoExecutionEligible) {
      setOpenCodeOutput(toolWidget, isAgentEnabled
        ? 'Не выполнено: вызов найден в истории чата. Отправьте сообщение, чтобы запустить агента.'
        : 'Не выполнено: включите Agent, чтобы разрешить выполнение инструментов.');
      return;
    }

    if (executedTurns.has(turnKey) || !isLatestAssistantBlock(block)) {
      // React re-render, reload, an old message, or a second tool block in the
      // same answer: replay this block's cached result but never execute or send
      // again.
      const cached = findCachedOutput(blockKey);
      setOpenCodeOutput(toolWidget, typeof cached === 'string'
        ? cached
        : (executedTurns.has(turnKey)
          ? 'В этом сообщении уже выполнен другой инструмент — вызов пропущен.'
          : 'Исторический вызов: повторно не выполняется.'));
      duSendLog('tool-skip-already-executed', { tool: toolObj.tool, turn: turnKey, latest: isLatestAssistantBlock(block) });
      return;
    }

    markExecuted(turnKey);
    duSendLog('tool-execute', { tool: toolObj.tool, turn: turnKey, chars: (toolObj.code || toolObj.content || '').length });

    // If this is an interactive question tool, PAUSE loop and render interactive selection card
    if (toolObj.tool === 'question' || toolObj.tool === 'ask') {
      renderInteractiveQuestionCard(toolWidget, toolObj);
      return;
    }

    const res = await runInSandbox(toolObj);
    const outputStr = typeof res.output === 'string' ? res.output : '';
    setOpenCodeOutput(toolWidget, outputStr || '(no output)');

    // Record what the sandbox actually returned. If this length is 0 the model
    // text was extracted fine but the tool produced no output; the send log
    // then shows whether the empty part is on the sandbox or on the send side.
    markExecuted(turnKey, blockKey, outputStr);
    duSendLog('tool-output', {
      tool: toolObj.tool,
      success: res.success !== false,
      outLen: outputStr.length,
      preview: outputStr.slice(0, 60)
    });
    if (outputStr.trim() === '') {
      duSendLog('tool-output-EMPTY', { tool: toolObj.tool, note: 'sandbox returned no output' });
    }

    // Autonomous Multi-Turn ReAct loop:
    // Allow the agent to call multiple tools sequentially if needed, or conclude when finished
    const reply = `[SANDBOX OUTPUT (${toolObj.tool})]:\n${outputStr}\n\nContinue with your next tool call if more steps are needed, or provide your final answer.`;
    sendSilentReply(reply);
   } catch (err) {
    console.error('[DeepUpgrade] tool block processing failed:', err);
    duSendLog('tool-error', { error: String((err && err.message) || err) });
   }
  });
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
  if (tool === 'write') return { label: `Запись: ${toolCardFileName(path)}`, inputHtml: `<div class="du-diff-file-tag">${escapeHtml(path)}</div>${toolCardPending('Приём содержимого файла…')}` };
  if (tool === 'edit') return { label: `Правка: ${toolCardFileName(path)}`, inputHtml: `<div class="du-diff-file-tag">${escapeHtml(path)}</div>${toolCardPending('Приём правки…')}` };
  if (tool === 'read') return { label: `Чтение: ${toolCardFileName(path)}`, inputHtml: `<div class="du-diff-file-tag">${escapeHtml(path)}</div>${toolCardPending('Чтение файла…')}` };
  if (tool === 'python' || tool === 'py') return { label: 'Python', inputHtml: toolCardPending('Приём кода…') };
  if (tool === 'js') return { label: 'JavaScript', inputHtml: toolCardPending('Приём кода…') };
  if (tool === 'glob') return { label: `Поиск файлов: ${(toolObj && toolObj.pattern) || '*'}`, inputHtml: toolCardPending('Приём шаблона…') };
  if (tool === 'grep') return { label: `Поиск в коде: ${(toolObj && toolObj.pattern) || ''}`, inputHtml: toolCardPending('Приём шаблона…') };
  if (tool === 'todowrite' || tool === 'todo') return { label: 'План выполнения', inputHtml: toolCardPending('Обновление плана…') };
  return { label: 'Терминал', inputHtml: toolCardPending('Приём команды…') };
}

function toolCardContent(toolObj, streaming) {
  if (streaming) return toolCardStreamingContent(toolObj);

  let label = 'Терминал';
  let inputContent = '';

  if (toolObj.tool === 'todowrite' || toolObj.tool === 'todo') {
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

  return { label, inputHtml: inputContent };
}

function toolCardKey(toolObj) {
  const body = toolObj.content || toolObj.code || toolObj.new_str || '';
  return [toolObj.tool, toolObj.path || '', body.length].join('|');
}

function applyToolCardContent(root, toolObj, streaming) {
  const { label, inputHtml } = toolCardContent(toolObj || {}, streaming);
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
  btn.onclick = () => {
    const isOpen = root.getAttribute('data-open') === 'true';
    root.setAttribute('data-open', !isOpen ? 'true' : 'false');
  };
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

// --- Native Settings Tab: Skills Integration ---
let isSkillsTabActive = false;

function injectSkillsSettingsButton() {
  const settingsNav = document.querySelector('.d316d158');
  if (!settingsNav || settingsNav.querySelector('.du-skills-nav-btn')) return;

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

  // When clicking any original DeepSeek tabs, restore original content
  const origTabs = settingsNav.querySelectorAll('div[role="button"]:not(.du-skills-nav-btn)');
  origTabs.forEach(t => {
    t.addEventListener('click', () => {
      deactivateSkillsTab(btn, settingsNav);
    }, { capture: true });
  });

  settingsNav.appendChild(btn);
}

function activateSkillsTab(skillsBtn, settingsNav) {
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
  skillsBtn.classList.remove('_699d482');
  skillsBtn.style.removeProperty('--dsl-button-color');

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
    isAgentEnabled = !isAgentEnabled;
    localStorage.setItem('du_agent_enabled', JSON.stringify(isAgentEnabled));
    btn.setAttribute('aria-pressed', isAgentEnabled ? 'true' : 'false');
    if (isAgentEnabled) {
      btn.classList.add('ds-toggle-button--selected');
    } else {
      btn.classList.remove('ds-toggle-button--selected');
    }
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
