// DeepUpgrade - OpenCode Authentic Core v7.0 (Skills Engine & Settings Integration)
console.log('%c[DeepUpgrade] OpenCode Engine v7.0 Active', 'background: #3b82f6; color: white; font-weight: bold; padding: 2px 6px;');

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

  return `[SYSTEM INSTRUCTION: OPENCODE AUTONOMOUS AGENT ACTIVE]
You are DeepUpgrade, an autonomous AI software engineer and terminal runtime environment powered by OpenCode architecture.
You have direct access to a high-performance in-browser WebAssembly POSIX sandbox:
- Isolated Virtual File System (VFS mounted at root '/')
- POSIX Shell with core utilities & network access (curl, fetch)
- Python 3.12 (Pyodide WASM runtime with standard libraries)
- JavaScript / Node-compatible async executor

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
   - Usage: For directory traversal (ls, pwd), inspecting processes, git, or testing CLI tools.
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
    }
  });
}
initSandboxIframe();

function runInSandbox(toolObj) {
  return new Promise((resolve) => {
    if (!sandboxIframe || !sandboxIframe.contentWindow) {
      initSandboxIframe();
    }
    const id = Math.random().toString(36).slice(2);

    pendingCalls.set(id, (res) => {
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

const executedSet = new Set(JSON.parse(sessionStorage.getItem('du_executed_blocks') || '[]'));
function markExecuted(hash) {
  executedSet.add(hash);
  sessionStorage.setItem('du_executed_blocks', JSON.stringify([...executedSet]));
}

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

function findDeepSeekInput() {
  return document.querySelector('textarea, div[contenteditable="true"]');
}

function updateReactInput(inputEl, text) {
  if (!inputEl) return;
  inputEl.focus();

  if (inputEl.tagName && inputEl.tagName.toLowerCase() === 'textarea') {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                         Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = text;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } else {
    // Contenteditable or custom input element
    inputEl.textContent = text;
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  }
}

// Resilient, semantic detection of send button without depending on obfuscated class names
function findSendButton() {
  const inputEl = findDeepSeekInput();
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

function triggerSend() {
  const inputEl = findDeepSeekInput();
  const sendBtn = findSendButton();

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
    return true;
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
    return true;
  }

  return false;
}

// Hybrid Transport: DOM vs Direct Network API (Configurable in popup, default false for stability)
let useDirectNetworkApi = JSON.parse(localStorage.getItem('du_use_network_api') ?? 'false');

chrome.runtime?.onMessage?.addListener((req) => {
  if (req && req.action === 'set_use_network_api') {
    useDirectNetworkApi = !!req.value;
    localStorage.setItem('du_use_network_api', JSON.stringify(useDirectNetworkApi));
    console.log('[DeepUpgrade] Direct Network API Transport set to:', useDirectNetworkApi);
  }
});

async function sendSilentReply(text) {
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
          text
        }, '*');

        // Fallback timer if MAIN world doesn't answer in 4s
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve({ success: false, error: 'Network bridge timeout' });
        }, 4000);
      });

      if (networkResult.success) {
        console.log('%c[DeepUpgrade] ✅ Запрос инструмента успешно отправлен в Network API!', 'color: #4ade80;');
        return;
      } else {
        console.warn('[DeepUpgrade] Network API bridge вернул ошибку, переход на DOM:', networkResult.error);
      }
    } catch(err) {
      console.warn('[DeepUpgrade] Ошибка Network API, fallback на DOM эмуляцию:', err);
    }
  }

  // Option 2 (Fallback): DOM Emulation
  const inputEl = findDeepSeekInput();
  if (!inputEl) return;

  const container = inputEl.closest('form, div:has(textarea), div:has([contenteditable])') || inputEl.parentElement;
  if (container) container.classList.add('du-locked-box');
  inputEl.classList.add('du-freezing');

  updateReactInput(inputEl, text);

  let attempts = 0;
  const maxAttempts = 35;
  const trySend = () => {
    attempts++;
    triggerSend();

    // Check if input was consumed and cleared by the React submission handler
    const currentVal = (inputEl.value !== undefined ? inputEl.value : inputEl.textContent || '').trim();
    if (currentVal.length === 0 || !currentVal.includes(text.slice(0, 20))) {
      inputEl.classList.remove('du-freezing');
      if (container) container.classList.remove('du-locked-box');
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(trySend, 120);
    } else {
      // Final attempt: simulate direct click and clear lingering text
      triggerSend();
      setTimeout(() => {
        const remaining = (inputEl.value !== undefined ? inputEl.value : inputEl.textContent || '').trim();
        if (remaining.includes('[SANDBOX OUTPUT') || remaining.includes('[USER ANSWER]:')) {
          updateReactInput(inputEl, '');
        }
        inputEl.classList.remove('du-freezing');
        if (container) container.classList.remove('du-locked-box');
      }, 150);
    }
  };

  setTimeout(trySend, 150);
}

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

function extractToolCall(text) {
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
    const contentMatch = text.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/) || text.match(/"text"\s*:\s*"([\s\S]*?)"\s*\}/);
    if (pathMatch) {
      let rawContent = contentMatch ? contentMatch[1] : '';
      rawContent = rawContent.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      return {
        tool: 'write',
        path: pathMatch[1],
        content: rawContent
      };
    }
  }

  if (toolName === 'edit') {
    // If strict JSON.parse worked, it was already handled above.
    // Handle fallback regex extraction with support for multiple lines:
    const pathMatch = text.match(/"path"\s*:\s*"([^"]+)"/);
    const oldMatch = text.match(/"old_str"\s*:\s*"([\s\S]*?)"\s*,\s*"new_str"/);
    const newMatch = text.match(/"new_str"\s*:\s*"([\s\S]*?)"\s*\}\s*$/) || text.match(/"new_str"\s*:\s*"([\s\S]*?)"\s*\}/);
    if (pathMatch) {
      let oldS = oldMatch ? oldMatch[1] : '';
      let newS = newMatch ? newMatch[1] : '';
      try {
        oldS = JSON.parse(`"${oldS}"`);
      } catch (e) {
        oldS = oldS.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      try {
        newS = JSON.parse(`"${newS}"`);
      } catch (e) {
        newS = newS.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      return {
        tool: 'edit',
        path: pathMatch[1],
        old_str: oldS,
        new_str: newS
      };
    }
  }

  const codeMatch = text.match(/"code"\s*:\s*"([\s\S]*?)"\s*\}/);
  if (codeMatch) {
    let rawCode = codeMatch[1];
    rawCode = rawCode.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    return {
      tool: toolName,
      code: rawCode
    };
  }

  return null;
}

function processToolCalls() {
  cleanAndUnifyChat();

  // Find all code blocks (strictly targeting container .md-code-block or standalone pre)
  const allBlocks = Array.from(document.querySelectorAll('.md-code-block, pre'));
  if (allBlocks.length === 0) return;

  allBlocks.forEach(async block => {
    // If this is a <pre> whose parent .md-code-block is already processed, skip
    if (block.tagName.toLowerCase() === 'pre' && block.closest('.md-code-block')) {
      const parentBlock = block.closest('.md-code-block');
      if (parentBlock.hasAttribute('data-du-rendered') || parentBlock.hasAttribute('data-du-widget-attached')) return;
      block = parentBlock; // Process the parent wrapper directly
    }

    if (block.hasAttribute('data-du-rendered') || block.hasAttribute('data-du-widget-attached')) return;

    const codeText = block.innerText || '';
    const toolObj = extractToolCall(codeText);
    if (!toolObj) return;

    const blockHash = 'du_' + codeText.replace(/\s+/g, '').slice(0, 80);

    block.setAttribute('data-du-rendered', 'true');
    const toolWidget = renderOpenCode1to1(block, toolObj);

    let res = await runInSandbox(toolObj);
    setOpenCodeOutput(toolWidget, res.output);

    // Auto-execution check: allowExecution flag OR active agent mode
    const isAutoExecutionEligible = (allowExecution || isAgentEnabled) && !executedSet.has(blockHash);

    if (isAutoExecutionEligible) {
      markExecuted(blockHash);

      // If this is an interactive question tool, PAUSE loop and render interactive selection card
      if (toolObj.tool === 'question' || toolObj.tool === 'ask') {
        renderInteractiveQuestionCard(toolWidget, toolObj);
        return;
      }

      // Autonomous Multi-Turn ReAct loop:
      // Allow the agent to call multiple tools sequentially if needed, or conclude when finished
      const reply = `[SANDBOX OUTPUT (${toolObj.tool})]:\n${res.output}\n\nContinue with your next tool call if more steps are needed, or provide your final answer.`;
      sendSilentReply(reply);
    } else {
      markExecuted(blockHash);
      if (toolObj.tool === 'question' || toolObj.tool === 'ask') {
        renderInteractiveQuestionCard(toolWidget, toolObj, true);
      }
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

function renderOpenCode1to1(originalPre, toolObj) {
  const targetToReplace = originalPre.closest('.md-code-block') || originalPre;
  targetToReplace.setAttribute('data-du-widget-attached', 'true');

  const root = document.createElement('div');
  root.className = 'opencode-tool-root';
  root.setAttribute('data-open', 'false');
  root.setAttribute('data-running', 'true');

  let label = 'Оболочка';
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
    const preview = (toolObj.content || '').split('\n').slice(0, 15).map(l => `<div class="du-diff-add">+ ${escapeHtml(l)}</div>`).join('');
    inputContent = `<div class="du-diff-file-tag">${escapeHtml(toolObj.path || '')}</div>${preview}`;
  } else if (toolObj.tool === 'edit') {
    const filename = (toolObj.path || 'file').split('/').filter(Boolean).pop() || toolObj.path;
    label = `Правка: ${filename}`;
    const oldLines = (toolObj.old_str || '').split('\n').map(l => `<div class="du-diff-del">- ${escapeHtml(l)}</div>`).join('');
    const newLines = (toolObj.new_str || '').split('\n').map(l => `<div class="du-diff-add">+ ${escapeHtml(l)}</div>`).join('');
    inputContent = `<div class="du-diff-file-tag">${escapeHtml(toolObj.path || '')}</div>${oldLines}${newLines}`;
  } else if (toolObj.tool === 'install_skill' || toolObj.tool === 'add_skill') {
    label = `Установка скилла: ${toolObj.name || 'Custom Skill'}`;
    inputContent = `<div class="du-diff-file-tag">SKILL REGISTRY</div><div class="du-diff-add">+ ${escapeHtml(toolObj.desc || '')}</div>`;
  } else if (toolObj.tool === 'python' || toolObj.tool === 'py') {
    label = 'Python';
    inputContent = escapeHtml(toolObj.code || '');
  } else if (toolObj.tool === 'js') {
    label = 'JavaScript';
    inputContent = escapeHtml(toolObj.code || '');
  } else {
    label = 'Оболочка';
    inputContent = escapeHtml(toolObj.code || '');
  }

  root.innerHTML = `
    <button class="opencode-tool-header-btn" type="button">
      <span class="opencode-tool-text">${label}</span>
      <svg class="opencode-tool-caret" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="opencode-terminal-box">
      <div class="opencode-terminal-input">${inputContent}</div>
      <div class="opencode-terminal-output">Вычисление...</div>
    </div>
  `;

  // Safely mount widget inside without breaking React's parent-child sibling hierarchy
  targetToReplace.style.setProperty('display', 'none', 'important');
  if (targetToReplace.parentNode) {
    targetToReplace.parentNode.appendChild(root);
  }

  const btn = root.querySelector('.opencode-tool-header-btn');
  btn.onclick = () => {
    const isOpen = root.getAttribute('data-open') === 'true';
    root.setAttribute('data-open', !isOpen ? 'true' : 'false');
  };

  const parentVirtualRow = root.closest('div._9663006') || root.closest('div[data-virtual-list-item-key]');
  if (parentVirtualRow) {
    const act = parentVirtualRow.querySelector('div.ds-flex._0a3d93b');
    if (act) act.style.setProperty('display', 'none', 'important');
  }

  return root;
}

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
let currentProjectName = localStorage.getItem('du_active_project') || 'DeepUpgrade';

function injectProjectSelector() {
  // Target the exact DeepSeek input card container from DOM
  const card = document.querySelector('div._77cefa5._9996a53') || 
               document.querySelector('div._020ab5b')?.parentElement ||
               findDeepSeekInput()?.closest('div:has(textarea)');
  if (!card) return;

  const parent = card.parentElement;
  if (!parent) return;

  let outerPlate = card.previousElementSibling?.classList.contains('du-project-plate') ? card.previousElementSibling : null;
  
  if (!outerPlate) {
    // If not yet injected, create the outer card wrapper behind the input card
    if (!parent.classList.contains('du-project-outer-wrapper')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'du-project-outer-wrapper';
      parent.insertBefore(wrapper, card);
      
      const bar = document.createElement('div');
      bar.className = 'du-project-top-bar';
      bar.innerHTML = `
        <button class="du-project-select-btn" type="button" title="Выбрать активный проект">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.5L8 4H12.5C13.3284 4 14 4.67157 14 5.5V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
          </svg>
          <span class="du-project-name">${escapeHtml(currentProjectName)}</span>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="du-project-add-btn" type="button" title="Открыть папку с диска в VFS">+</button>
        <input type="file" class="du-project-folder-input" webkitdirectory directory multiple style="display: none;">
      `;

      const addBtn = bar.querySelector('.du-project-add-btn');
      const fileInput = bar.querySelector('.du-project-folder-input');
      addBtn.onclick = () => fileInput.click();
      fileInput.onchange = async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const firstRel = files[0].webkitRelativePath || '';
        const folderName = firstRel.split('/')[0] || 'Project';
        currentProjectName = folderName;
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

      wrapper.appendChild(bar);
      wrapper.appendChild(card);
    }
  }
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
});

observer.observe(document.documentElement, { childList: true, subtree: true });
cleanAndUnifyChat();
hookInput();
hookAttachmentElements();
processToolCalls();
injectSkillsSettingsButton();
injectAgentToggleButton();
runAttachmentCleanup();
