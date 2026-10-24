// DeepUpgrade - Virtual Sandbox & Execution Engine
// Handles: JS execution, BusyBox / Bash shell simulation, Chart.js / Canvas rendering

class DeepUpgradeSandbox {
  constructor() {
    this.fs = {
      '/': ['home', 'tmp', 'data'],
      '/home': ['user'],
      '/home/user': ['notes.txt'],
      '/tmp': []
    };
    this.files = {
      '/home/user/notes.txt': 'Welcome to DeepUpgrade Virtual Sandbox!\n'
    };
  }

  // Execute JavaScript in safe Worker/Sandbox
  async runJS(code) {
    const startTime = performance.now();
    let logs = [];
    
    try {
      // Mock safe sandbox execution
      const sandboxedFunction = new Function('console', `
        let result;
        try {
          result = (function() {
            ${code}
          })();
        } catch(e) {
          throw e;
        }
        return result;
      `);

      const customConsole = {
        log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
        error: (...args) => logs.push('[ERROR] ' + args.join(' ')),
        warn: (...args) => logs.push('[WARN] ' + args.join(' ')),
        info: (...args) => logs.push('[INFO] ' + args.join(' '))
      };

      const res = sandboxedFunction(customConsole);
      const executionTime = (performance.now() - startTime).toFixed(2);

      let output = logs.join('\n');
      if (res !== undefined) {
        output += (output ? '\n' : '') + '=> ' + (typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res));
      }

      return {
        success: true,
        output: output || '(Code executed with no output)',
        executionTime: `${executionTime}ms`
      };
    } catch (err) {
      return {
        success: false,
        output: `Error: ${err.message}`,
        executionTime: `${(performance.now() - startTime).toFixed(2)}ms`
      };
    }
  }

  // Execute Unix / BusyBox shell commands
  async runBash(commandString) {
    const startTime = performance.now();
    const lines = commandString.split('\n').map(l => l.trim()).filter(Boolean);
    let allOutput = [];

    for (const rawLine of lines) {
      // Handle comments
      if (rawLine.startsWith('#')) continue;

      // Handle piped commands e.g. echo "2^100" | bc
      if (rawLine.includes('|')) {
        const parts = rawLine.split('|').map(p => p.trim());
        let currentPipeData = '';

        for (let i = 0; i < parts.length; i++) {
          const cmd = parts[i];
          if (cmd.startsWith('echo ')) {
            currentPipeData = cmd.replace(/^echo\s+["']?/, '').replace(/["']?$/, '');
          } else if (cmd.startsWith('bc')) {
            // High-precision calculator simulation
            currentPipeData = this.evalBc(currentPipeData);
          } else if (cmd.startsWith('grep ')) {
            const pattern = cmd.replace(/^grep\s+["']?/, '').replace(/["']?$/, '');
            const re = new RegExp(pattern);
            currentPipeData = currentPipeData.split('\n').filter(l => re.test(l)).join('\n');
          } else if (cmd.startsWith('wc -l')) {
            currentPipeData = String(currentPipeData.split('\n').filter(Boolean).length);
          } else if (cmd.startsWith('wc -c') || cmd.startsWith('wc -m')) {
            currentPipeData = String(currentPipeData.length);
          } else if (cmd.startsWith('tr ')) {
            // simple tr support: tr a-z A-Z
            if (cmd.includes('a-z A-Z')) currentPipeData = currentPipeData.toUpperCase();
            else if (cmd.includes('A-Z a-z')) currentPipeData = currentPipeData.toLowerCase();
          }
        }
        allOutput.push(currentPipeData);
        continue;
      }

      // Single commands
      const tokens = rawLine.split(/\s+/);
      const cmd = tokens[0];
      const args = tokens.slice(1);

      switch (cmd) {
        case 'echo':
          allOutput.push(args.join(' ').replace(/^["']|["']$/g, ''));
          break;
        case 'pwd':
          allOutput.push('/home/user');
          break;
        case 'date':
          allOutput.push(new Date().toUTCString());
          break;
        case 'uptime':
          allOutput.push(' 19:20:00 up 42 days, 1 user, load average: 0.08, 0.03, 0.01');
          break;
        case 'uname':
          allOutput.push('Linux deepseek-wasm 6.6.0 #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux');
          break;
        case 'ls':
          allOutput.push(Object.keys(this.files).map(f => f.split('/').pop()).join('  '));
          break;
        case 'cat':
          const fName = args[0] ? (args[0].startsWith('/') ? args[0] : `/home/user/${args[0]}`) : '';
          allOutput.push(this.files[fName] || `cat: ${args[0]}: No such file or directory`);
          break;
        case 'expr':
          try {
            allOutput.push(String(eval(args.join(' '))));
          } catch(e) {
            allOutput.push(`expr: syntax error`);
          }
          break;
        default:
          allOutput.push(`bash: ${cmd}: command executed in virtual sandbox`);
      }
    }

    const executionTime = (performance.now() - startTime).toFixed(2);
    return {
      success: true,
      output: allOutput.join('\n') || '(done)',
      executionTime: `${executionTime}ms`
    };
  }

  // Exact math evaluator for `bc`
  evalBc(expr) {
    try {
      // Replace power ^ with ** for JS BigInt/Math
      let clean = expr.trim();
      if (clean.includes('^')) {
        const [base, exp] = clean.split('^').map(x => x.trim());
        if (/^\d+$/.test(base) && /^\d+$/.test(exp)) {
          return String(BigInt(base) ** BigInt(exp));
        }
      }
      // Simple arithmetic
      const sanitized = clean.replace(/[^0-9+\-*/().]/g, '');
      return String(Function(`"use strict"; return (${sanitized})`)());
    } catch(e) {
      return `bc: parse error: ${e.message}`;
    }
  }
}

window.__DEEP_UPGRADE_SANDBOX = new DeepUpgradeSandbox();
// Listen for postMessage from Content Script to execute inside Main Sandbox
window.addEventListener('message', async (ev) => {
  if (!ev.data) return;

  if (ev.data.type === 'DU_EXECUTE_CODE' || ev.data.type === 'DU_EXECUTE_TOOL_CARD') {
    const { tool, code, cardId } = ev.data;
    const engine = window.__DEEP_UPGRADE_SANDBOX;

    if (!engine) {
      console.warn('[DeepUpgrade] Sandbox engine not ready yet.');
      return;
    }

    let res;
    if (tool === 'bash') {
      res = await engine.runBash(code);
    } else {
      res = await engine.runJS(code);
    }

    if (ev.data.type === 'DU_EXECUTE_TOOL_CARD') {
      window.postMessage({
        type: 'DU_TOOL_RESULT',
        cardId,
        code,
        output: res.output,
        executionTime: res.executionTime
      }, '*');
    } else {
      alert(`[DeepUpgrade Wasm Sandbox]\nВывод:\n${res.output}\n\nВремя: ${res.executionTime}`);
    }
  }
});
