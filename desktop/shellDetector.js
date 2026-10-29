// DeepUpgrade Desktop - Shell Detector Utility
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function detectAvailableShells() {
  const isWin = process.platform === 'win32';
  const shells = [];

  if (isWin) {
    // 1. Git Bash
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')
    ];
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) {
        shells.push({
          id: 'git-bash',
          name: 'Git Bash (POSIX Recommended)',
          path: p,
          type: 'bash',
          icon: 'terminal',
          recommended: true
        });
        break;
      }
    }

    // 2. WSL (Windows Subsystem for Linux)
    const wslPath = 'C:\\WINDOWS\\system32\\wsl.exe';
    if (fs.existsSync(wslPath)) {
      shells.push({
        id: 'wsl',
        name: 'WSL (Linux Bash / Ubuntu)',
        path: wslPath,
        type: 'bash',
        icon: 'linux'
      });
    }

    // 3. PowerShell 7 (pwsh)
    try {
      const pwshOut = execSync('where pwsh', { stdio: 'pipe' }).toString().trim().split('\r\n')[0];
      if (pwshOut && fs.existsSync(pwshOut)) {
        shells.push({
          id: 'pwsh',
          name: 'PowerShell 7 (pwsh)',
          path: pwshOut,
          type: 'powershell',
          icon: 'powershell'
        });
      }
    } catch (e) {}

    // 4. Windows PowerShell 5.1
    const winPsPath = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    if (fs.existsSync(winPsPath)) {
      shells.push({
        id: 'powershell',
        name: 'Windows PowerShell',
        path: winPsPath,
        type: 'powershell',
        icon: 'powershell'
      });
    }

    // 5. Command Prompt (cmd.exe)
    const cmdPath = 'C:\\WINDOWS\\system32\\cmd.exe';
    if (fs.existsSync(cmdPath)) {
      shells.push({
        id: 'cmd',
        name: 'Command Prompt (cmd.exe)',
        path: cmdPath,
        type: 'cmd',
        icon: 'terminal'
      });
    }
  } else {
    // Linux / macOS
    const unixShells = [
      { id: 'bash', name: 'Bash', path: '/bin/bash' },
      { id: 'zsh', name: 'Zsh', path: '/bin/zsh' }
    ];
    for (const s of unixShells) {
      if (fs.existsSync(s.path)) {
        shells.push({ ...s, type: 'bash', recommended: s.id === 'bash' });
      }
    }
  }

  return shells;
}

module.exports = {
  detectAvailableShells
};
