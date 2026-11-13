// Popup Settings Controller
document.addEventListener('DOMContentLoaded', () => {
  const themeSelect = document.getElementById('themeSelect');
  const toolToggle = document.getElementById('toolToggle');
  const autoRunToggle = document.getElementById('autoRunToggle');
  const cleanupDaysSelect = document.getElementById('cleanupDaysSelect');
  const blockTelemetryToggle = document.getElementById('blockTelemetryToggle');
  const directNetworkApiToggle = document.getElementById('directNetworkApiToggle');

  // Settings are global, so every open DeepSeek tab has to receive them -
  // not only the tab that happens to be focused while the popup is open.
  const notifyDeepSeekTabs = (message) => {
    chrome.tabs.query({ url: ['https://chat.deepseek.com/*'] }, (tabs) => {
      (tabs || []).forEach(tab => {
        if (!tab.id) return;
        chrome.tabs.sendMessage(tab.id, message, () => {
          void chrome.runtime.lastError;
        });
      });
    });
  };

  // Load saved settings
  chrome.storage.local.get(['du_theme', 'du_tools_enabled', 'du_autorun', 'du_cleanup_days', 'du_block_telemetry', 'du_use_network_api'], (res) => {
    if (res.du_theme) themeSelect.value = res.du_theme;
    if (res.du_tools_enabled !== undefined) toolToggle.checked = res.du_tools_enabled;
    if (res.du_autorun !== undefined) autoRunToggle.checked = res.du_autorun;
    if (res.du_cleanup_days !== undefined) cleanupDaysSelect.value = res.du_cleanup_days;
    if (res.du_block_telemetry !== undefined) blockTelemetryToggle.checked = res.du_block_telemetry;
    if (res.du_use_network_api !== undefined && directNetworkApiToggle) directNetworkApiToggle.checked = res.du_use_network_api;
  });

  if (directNetworkApiToggle) {
    directNetworkApiToggle.addEventListener('change', () => {
      chrome.storage.local.set({ du_use_network_api: directNetworkApiToggle.checked });
      notifyDeepSeekTabs({ action: 'set_use_network_api', value: directNetworkApiToggle.checked });
    });
  }

  if (blockTelemetryToggle) {
    blockTelemetryToggle.addEventListener('change', () => {
      chrome.storage.local.set({ du_block_telemetry: blockTelemetryToggle.checked });
      notifyDeepSeekTabs({ action: 'set_block_telemetry', value: blockTelemetryToggle.checked });
    });
  }

  if (cleanupDaysSelect) {
    cleanupDaysSelect.addEventListener('change', () => {
      const days = parseInt(cleanupDaysSelect.value, 10);
      chrome.storage.local.set({ du_cleanup_days: days });
      notifyDeepSeekTabs({ action: 'set_cleanup_days', days });
    });
  }

  // Save on change
  themeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ du_theme: themeSelect.value });
    notifyDeepSeekTabs({ action: 'set_theme', theme: themeSelect.value });
  });

  toolToggle.addEventListener('change', () => {
    console.log('[DeepUpgrade Popup] Setting du_tools_enabled to:', toolToggle.checked);
    // chrome.storage.local is the durable source of truth; the page mirrors it
    // into its own localStorage and notifies the MAIN-world interceptor.
    chrome.storage.local.set({ du_tools_enabled: toolToggle.checked });
    // Notify every open DeepSeek tab, not only the active one: the switch is
    // global and a background tab must not keep running the agent.
    chrome.tabs.query({ url: ['https://chat.deepseek.com/*'] }, (tabs) => {
      (tabs || []).forEach(tab => {
        if (!tab.id) return;
        chrome.tabs.sendMessage(tab.id, { action: 'set_agent_enabled', value: toolToggle.checked }, () => {
          void chrome.runtime.lastError;
        });
      });
    });
  });

  autoRunToggle.addEventListener('change', () => {
    chrome.storage.local.set({ du_autorun: autoRunToggle.checked });
  });
});
