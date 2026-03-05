/**
 * Odoo POS State Debugger - Content Script
 *
 * Runs in the isolated world. Injects inject.js into the page context
 * and relays messages between the page and the extension popup.
 */
(function () {
  "use strict";

  // Inject the page-world script
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  // State tracked for popup queries
  let lastStatus = { connected: false, reduxDevTools: false, posmodelReady: false };

  // Relay messages from inject.js (page world) to extension internals
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "ODOO_POS_DEVTOOLS") return;

    const { type, payload } = event.data;

    if (type === "STATUS_UPDATE") {
      lastStatus = payload;
    }
  });

  // Respond to popup queries for status
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_STATUS") {
      sendResponse(lastStatus);
      return true;
    }

    if (message.type === "UPDATE_CONFIG") {
      // Forward config changes to inject.js
      window.postMessage(
        { source: "ODOO_POS_DEVTOOLS_CONFIG", type: "CONFIG_UPDATE", payload: message.payload },
        "*"
      );
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "REFRESH_SNAPSHOT") {
      window.postMessage(
        { source: "ODOO_POS_DEVTOOLS_CONFIG", type: "REFRESH_SNAPSHOT" },
        "*"
      );
      sendResponse({ ok: true });
      return true;
    }
  });
})();
