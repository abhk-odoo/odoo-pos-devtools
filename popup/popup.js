/**
 * Odoo POS State Debugger - Popup Script (with settings only)
 */
(function () {
  "use strict";

  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const reduxWarning = document.getElementById("redux-warning");
  const debounceInput = document.getElementById("debounce-input");
  const pollInput = document.getElementById("poll-input");

  // ── Load saved config ──────────────────────────────────────────────

  function loadConfig(callback) {
    chrome.storage.local.get(
      { debounceMs: 50, pollIntervalMs: 500 },
      callback
    );
  }

  function saveConfig(data) {
    chrome.storage.local.set(data);
  }

  // ── Event handlers ─────────────────────────────────────────────────

  debounceInput.addEventListener("change", () => {
    const val = parseInt(debounceInput.value, 10);
    if (val >= 10 && val <= 1000) {
      saveConfig({ debounceMs: val });
      sendConfigUpdate({ debounceMs: val });
    }
  });

  pollInput.addEventListener("change", () => {
    const val = parseInt(pollInput.value, 10);
    if (val >= 100 && val <= 5000) {
      saveConfig({ pollIntervalMs: val });
      sendConfigUpdate({ pollIntervalMs: val });
    }
  });

  // ── Communication with content script ──────────────────────────────

  function sendToContentScript(message, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message, callback || (() => {}));
      }
    });
  }

  function sendConfigUpdate(payload) {
    sendToContentScript({ type: "UPDATE_CONFIG", payload });
  }

  // ── Status polling ─────────────────────────────────────────────────

  function updateStatus() {
    sendToContentScript({ type: "GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusDot.className = "dot red";
        statusText.textContent = "Not on a POS page";
        reduxWarning.classList.add("hidden");
        return;
      }

      if (response.connected && response.reduxDevTools) {
        statusDot.className = "dot green";
        statusText.textContent = "Connected to POS & Redux DevTools";
        reduxWarning.classList.add("hidden");
      } else if (response.connected && !response.reduxDevTools) {
        statusDot.className = "dot yellow";
        statusText.textContent = "Connected to POS";
        reduxWarning.classList.remove("hidden");
      } else if (response.posmodelReady === false && response.timeout) {
        statusDot.className = "dot red";
        statusText.textContent = "POS model not found (timeout)";
        reduxWarning.classList.add("hidden");
      } else {
        statusDot.className = "dot red";
        statusText.textContent = "Waiting for POS...";
        reduxWarning.classList.add("hidden");
      }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────

  loadConfig((cfg) => {
    debounceInput.value = cfg.debounceMs;
    pollInput.value = cfg.pollIntervalMs;
  });

  updateStatus();
  // Refresh status every 2 seconds while popup is open
  setInterval(updateStatus, 2000);
})();