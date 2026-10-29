// DeepUpgrade Setup UI Controller
let availableShells = [];
let selectedShell = null;

async function initSetup() {
  const countEl = document.getElementById('shell-count');
  const container = document.getElementById('shells-container');

  try {
    availableShells = await window.electronAPI.getAvailableShells();
    countEl.innerText = `Найдено: ${availableShells.length}`;

    container.innerHTML = '';
    availableShells.forEach((shell, idx) => {
      const item = document.createElement('div');
      item.className = 'shell-item' + (shell.recommended || idx === 0 ? ' selected' : '');
      if (shell.recommended || idx === 0) selectedShell = shell;

      item.innerHTML = `
        <div class="shell-info">
          <div class="shell-name">
            <span>${shell.name}</span>
            ${shell.recommended ? '<span class="tag-rec">Рекомендуется</span>' : ''}
          </div>
          <div class="shell-path">${shell.path}</div>
        </div>
        <div class="radio-circle"></div>
      `;

      item.onclick = () => {
        document.querySelectorAll('.shell-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedShell = shell;
      };

      container.appendChild(item);
    });
  } catch (err) {
    countEl.innerText = 'Ошибка поиска';
    console.error(err);
  }

  // Launch button
  document.getElementById('btn-launch').onclick = async () => {
    const config = {
      shell: selectedShell,
      autoExec: document.getElementById('perm-auto-exec').checked,
      fsAccess: document.getElementById('perm-fs').checked,
      completed: true
    };

    await window.electronAPI.saveConfig(config);
    window.electronAPI.launchApp();
  };
}

document.addEventListener('DOMContentLoaded', initSetup);
