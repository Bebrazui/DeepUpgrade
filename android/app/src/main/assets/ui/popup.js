// Popup Settings Controller
document.addEventListener('DOMContentLoaded', () => {
  const themeSelect = document.getElementById('themeSelect');
  const toolToggle = document.getElementById('toolToggle');
  const autoRunToggle = document.getElementById('autoRunToggle');
  const cleanupDaysSelect = document.getElementById('cleanupDaysSelect');
  const blockTelemetryToggle = document.getElementById('blockTelemetryToggle');
  const directNetworkApiToggle = document.getElementById('directNetworkApiToggle');

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
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'set_use_network_api', value: directNetworkApiToggle.checked });
        }
      });
    });
  }

  if (blockTelemetryToggle) {
    blockTelemetryToggle.addEventListener('change', () => {
      chrome.storage.local.set({ du_block_telemetry: blockTelemetryToggle.checked });
      // Also notify active tabs to update localStorage
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'set_block_telemetry', value: blockTelemetryToggle.checked });
        }
      });
    });
  }

  if (cleanupDaysSelect) {
    cleanupDaysSelect.addEventListener('change', () => {
      const days = parseInt(cleanupDaysSelect.value, 10);
      chrome.storage.local.set({ du_cleanup_days: days });
      // Notify active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'set_cleanup_days', days });
        }
      });
    });
  }

  // Save on change
  themeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ du_theme: themeSelect.value });
    // Notify active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'set_theme', theme: themeSelect.value });
      }
    });
  });

  toolToggle.addEventListener('change', () => {
    chrome.storage.local.set({ du_tools_enabled: toolToggle.checked });
  });

  autoRunToggle.addEventListener('change', () => {
    chrome.storage.local.set({ du_autorun: autoRunToggle.checked });
  });
});
