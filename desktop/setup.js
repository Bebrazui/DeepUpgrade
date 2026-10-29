// DeepUpgrade Setup UI Controller (matching popup.js style)
let availableShells = [];

async function initSetup() {
  const shellSelect = document.getElementById('shellSelect');
  const btnLaunch = document.getElementById('btnLaunch');
  const btnClose = document.getElementById('btnClose');
  const permExec = document.getElementById('permExec');
  const permFs = document.getElementById('permFs');
  const themeSelect = document.getElementById('themeSelect');

  if (btnClose) {
    btnClose.onclick = () => window.electronAPI.closeWindow();
  }

  try {
    availableShells = await window.electronAPI.getAvailableShells();
    shellSelect.innerHTML = '';
    
    availableShells.forEach((shell) => {
      const opt = document.createElement('option');
      opt.value = shell.id;
      opt.textContent = shell.name + (shell.recommended ? ' ★' : '');
      if (shell.recommended) opt.selected = true;
      shellSelect.appendChild(opt);
    });

    if (shellSelect.selectedIndex === -1 && shellSelect.options.length > 0) {
      shellSelect.selectedIndex = 0;
    }
  } catch (err) {
    console.error(err);
  }

  btnLaunch.onclick = async () => {
    const selectedId = shellSelect.value;
    const selectedObj = availableShells.find(s => s.id === selectedId) || availableShells[0] || null;

    const config = {
      shell: selectedObj,
      autoExec: permExec.checked,
      fsAccess: permFs.checked,
      theme: themeSelect.value,
      completed: true
    };

    await window.electronAPI.saveConfig(config);
    window.electronAPI.launchApp();
  };
}

document.addEventListener('DOMContentLoaded', initSetup);
