/**
 * Odoo POS State Debugger - Injected Page Script (Enhanced)
 *
 * Runs in the page's JS context with full access to window.posmodel.
 * Automatically discovers all models and store properties and connects to Redux DevTools.
 */
(function () {
  "use strict";

  // ── Guard against double injection ──────────────────────────────────
  if (window.__ODOO_POS_DEVTOOLS_INJECTED__) return;
  window.__ODOO_POS_DEVTOOLS_INJECTED__ = true;

  // ── Constants ───────────────────────────────────────────────────────
  const LOG_PREFIX = "[Odoo POS DevTools]";
  // Store polling interval (ms)
  const DEFAULT_POLL_INTERVAL = 500;
  // Debounce time for model events (ms)
  const DEFAULT_DEBOUNCE_MS = 50;
  // Blacklist of service properties to exclude from store snapshot
  const SERVICE_BLACKLIST = new Set([
    'env', 'numberBuffer', 'barcodeReader', 'ui', 'dialog', 'ticketPrinter',
    'bus', 'data', 'action', 'alert', 'router', 'sound', 'notification',
    'deviceSync', 'orderCounter', 'snoozedProductTracker', 'ready', 'models'
  ]);
  // Additional getters we want to include manually (since they are non-enumerable)
  const MANUAL_GETTERS = [
    'openOrder', 'selectedOrder', 'cashier', 'session', 'company', 'currency',
    'pickingType', 'user', 'config', 'productViewMode', 'showCashMoveButton',
    'printOptions', 'linesToRefund', 'isSelectedLineCombo', 'showSaveOrderButton'
  ];

  // ── Mutable config ─────────────────────────────────────────────────
  let config = {
    watchedModels: [],          // will be populated automatically
    debounceMs: DEFAULT_DEBOUNCE_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL,
  };

  // ── Runtime state ──────────────────────────────────────────────────
  let devTools = null;
  let RAW_SYMBOL = null;
  let currentState = { store: {}, models: {} };
  let unsubscribers = [];
  let pollTimerId = null;
  let previousStoreSnapshot = null;
  let pendingActions = [];
  let flushTimerId = null;

  // ── Utility: send status to content script ─────────────────────────
  function sendStatus(status) {
    window.postMessage(
      { source: "ODOO_POS_DEVTOOLS", type: "STATUS_UPDATE", payload: status },
      "*"
    );
  }

  // ── Utility: safe console log ──────────────────────────────────────
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  // ── Serialization (unchanged, robust) ──────────────────────────────
  function serializeValue(value, depth, maxDepth, visited) {
    if (value === null || value === undefined) return null;

    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") return value;
    if (type === "function") return undefined; // skip functions
    if (type === "bigint") return value.toString();

    if (value instanceof Set) return Array.from(value);
    if (value instanceof Date) return value.toISOString();

    // Luxon DateTime
    if (value && value.isLuxonDateTime === true) {
      try {
        return value.toISO();
      } catch {
        return "[DateTime]";
      }
    }

    if (depth >= maxDepth) return "[depth limit]";

    if (Array.isArray(value)) {
      if (visited.has(value)) return "[circular]";
      visited.add(value);
      const result = [];
      const len = Math.min(value.length, 100); // cap array length
      for (let i = 0; i < len; i++) {
        result.push(serializeValue(value[i], depth + 1, maxDepth, visited));
      }
      if (value.length > 100) result.push(`... +${value.length - 100} more`);
      return result;
    }

    if (typeof value === "object") {
      if (visited.has(value)) return "[circular]";
      visited.add(value);

      // If it has RAW_SYMBOL, serialize via raw
      if (RAW_SYMBOL && value[RAW_SYMBOL]) {
        return serializeRawObject(value[RAW_SYMBOL], depth + 1, maxDepth, visited);
      }

      const result = {};
      try {
        const keys = Object.keys(value);
        for (const key of keys) {
          if (key.startsWith("__lazy")) continue;
          try {
            result[key] = serializeValue(value[key], depth + 1, maxDepth, visited);
          } catch {
            result[key] = "[error reading]";
          }
        }
      } catch {
        return "[unserializable object]";
      }
      return result;
    }

    return String(value);
  }

  function serializeRawObject(raw, depth, maxDepth, visited) {
    if (!raw || typeof raw !== "object") return raw;
    if (visited.has(raw)) return "[circular]";
    visited.add(raw);

    const result = {};
    try {
      const keys = Object.keys(raw);
      for (const key of keys) {
        try {
          result[key] = serializeValue(raw[key], depth, maxDepth, visited);
        } catch {
          result[key] = "[error reading]";
        }
      }
    } catch {
      return "[unserializable]";
    }
    return result;
  }

  function serializeRecord(record) {
    const visited = new WeakSet();
    try {
      let data;
      if (RAW_SYMBOL && record[RAW_SYMBOL]) {
        data = serializeRawObject(record[RAW_SYMBOL], 0, 2, visited);
      } else if (record.raw && typeof record.raw === "object") {
        data = serializeRawObject(record.raw, 0, 2, visited);
      } else {
        data = serializeValue(record, 0, 2, visited);
      }
      return data;
    } catch (e) {
      return { _error: e.message };
    }
  }

  // ── Store snapshot (now includes all enumerable properties + manual getters) ──
  function snapshotStoreProperties() {
    const pos = window.posmodel;
    if (!pos) return {};

    const snapshot = {};

    // 1. Enumerable properties (excluding blacklist and functions)
    const keys = Object.keys(pos).filter(key => {
      if (SERVICE_BLACKLIST.has(key)) return false;
      const value = pos[key];
      return typeof value !== 'function';
    });

    for (const key of keys) {
      try {
        snapshot[key] = serializeValue(pos[key], 0, 3, new WeakSet());
      } catch (e) {
        snapshot[key] = "[error]";
      }
    }

    // 2. Manually add important getters (non-enumerable)
    for (const getter of MANUAL_GETTERS) {
      try {
        const value = pos[getter];
        if (value !== undefined) {
          snapshot[getter] = serializeValue(value, 0, 3, new WeakSet());
        }
      } catch (e) {
        snapshot[getter] = "[error]";
      }
    }

    return snapshot;
  }

  // ── Build full state snapshot (models + store) ──────────────────────
  function buildModelSnapshot(modelName) {
    const pos = window.posmodel;
    if (!pos || !pos.models || !pos.models[modelName]) return {};

    const model = pos.models[modelName];
    const records = {};
    let count = 0;

    try {
      const allRecords = model.getAll ? model.getAll() : [];
      for (const record of allRecords) {
        if (count >= 500) {
          records._truncated = true;
          records._totalCount = allRecords.length;
          break;
        }
        const id = String(record.id);
        records[id] = serializeRecord(record);
        count++;
      }
    } catch (e) {
      records._error = e.message;
    }

    return records;
  }

  function buildFullSnapshot() {
    const storeSnapshot = snapshotStoreProperties();
    const modelsSnapshot = {};

    // Use configured watched models (defaults to all discovered models)
    for (const modelName of config.watchedModels) {
      modelsSnapshot[modelName] = buildModelSnapshot(modelName);
    }

    return { store: storeSnapshot, models: modelsSnapshot };
  }

  // ── Debounced action dispatch (unchanged) ──────────────────────────
  function enqueueAction(action) {
    // Suppress during bulk loading
    try {
      if (window.posmodel && window.posmodel.models && window.posmodel.models._loadingData) {
        return;
      }
    } catch {
      // ignore
    }

    pendingActions.push(action);

    if (flushTimerId) clearTimeout(flushTimerId);
    flushTimerId = setTimeout(flushActions, config.debounceMs);
  }

  function flushActions() {
    flushTimerId = null;
    if (!devTools || pendingActions.length === 0) return;

    const actions = pendingActions.splice(0);

    // Group by model+type for batching
    const batches = new Map();

    for (const action of actions) {
      const key = action.type;
      if (!batches.has(key)) {
        batches.set(key, []);
      }
      batches.get(key).push(action);
    }

    for (const [type, group] of batches) {
      if (group.length === 1) {
        try {
          devTools.send(group[0], currentState);
        } catch (e) {
          warn("Failed to send action to DevTools:", e.message);
        }
      } else {
        const payloads = group.map((a) => a.payload);
        const batchAction = {
          type: type.replace(/(CREATE|UPDATE|DELETE)$/, "$1_BATCH"),
          payload: { count: payloads.length, items: payloads },
        };
        try {
          devTools.send(batchAction, currentState);
        } catch (e) {
          warn("Failed to send batch action to DevTools:", e.message);
        }
      }
    }
  }

  // ── Model event hooks (now hooks ALL models) ────────────────────────
  function hookModelEvents() {
    // Cleanup previous hooks
    for (const unsub of unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    unsubscribers = [];

    const pos = window.posmodel;
    if (!pos || !pos.models) return;

    // Use configured watched models (which should be all models by default)
    for (const modelName of config.watchedModels) {
      const model = pos.models[modelName];
      if (!model || typeof model.addEventListener !== "function") continue;

      // CREATE
      unsubscribers.push(
        model.addEventListener("create", (data) => {
          try {
            const records = {};
            const ids = data.ids || [];
            for (const id of ids) {
              const record = model.get(String(id));
              if (record) {
                records[String(id)] = serializeRecord(record);
                if (!currentState.models[modelName]) {
                  currentState.models[modelName] = {};
                }
                currentState.models[modelName][String(id)] = records[String(id)];
              }
            }
            enqueueAction({
              type: `${modelName}/CREATE`,
              payload: { ids: ids.map(String), records },
            });
          } catch (e) {
            warn(`Error handling create for ${modelName}:`, e.message);
          }
        })
      );

      // UPDATE
      unsubscribers.push(
        model.addEventListener("update", (data) => {
          try {
            const id = String(data.id);
            const fields = data.fields || [];

            const before = {};
            const cached = currentState.models[modelName]?.[id] || null;
            if (cached) {
              for (const f of fields) {
                before[f] = cached[f];
              }
            }

            const record = model.get(String(data.id));
            let after = {};
            if (record) {
              const serialized = serializeRecord(record);
              for (const f of fields) {
                after[f] = serialized[f];
              }
              if (!currentState.models[modelName]) {
                currentState.models[modelName] = {};
              }
              currentState.models[modelName][id] = serialized;
            }

            enqueueAction({
              type: `${modelName}/UPDATE`,
              payload: { id, fields, before, after },
            });
          } catch (e) {
            warn(`Error handling update for ${modelName}:`, e.message);
          }
        })
      );

      // DELETE
      unsubscribers.push(
        model.addEventListener("delete", (data) => {
          try {
            const id = String(data.id);
            const lastKnownData = currentState.models[modelName]?.[id] || null;

            if (currentState.models[modelName]) {
              delete currentState.models[modelName][id];
            }

            enqueueAction({
              type: `${modelName}/DELETE`,
              payload: { id, key: data.key, lastKnownData },
            });
          } catch (e) {
            warn(`Error handling delete for ${modelName}:`, e.message);
          }
        })
      );
    }

    log(`Hooked events for ${config.watchedModels.length} models`);
  }

  // ── Store property polling (deep comparison) ────────────────────────
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  function getChangedPaths(prev, curr, path = '') {
    const changes = {};
    if (prev === curr) return changes;
    if (typeof prev !== 'object' || prev === null || typeof curr !== 'object' || curr === null) {
      changes[path || 'root'] = { from: prev, to: curr };
      return changes;
    }

    const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
    for (const key of allKeys) {
      const newPath = path ? `${path}.${key}` : key;
      if (!(key in prev)) {
        changes[newPath] = { from: undefined, to: curr[key] };
      } else if (!(key in curr)) {
        changes[newPath] = { from: prev[key], to: undefined };
      } else {
        Object.assign(changes, getChangedPaths(prev[key], curr[key], newPath));
      }
    }
    return changes;
  }

  function startStorePolling() {
    stopStorePolling();
    previousStoreSnapshot = snapshotStoreProperties();

    pollTimerId = setInterval(() => {
      if (document.hidden) return;
      if (!window.posmodel) {
        handleDisconnect();
        return;
      }

      try {
        const current = snapshotStoreProperties();
        if (!deepEqual(previousStoreSnapshot, current)) {
          const changes = getChangedPaths(previousStoreSnapshot, current);
          // Update currentState.store
          currentState.store = current;
          previousStoreSnapshot = current;

          if (devTools) {
            try {
              devTools.send({ type: "STORE/CHANGE", payload: { changes } }, currentState);
            } catch (e) {
              warn("Failed to send store change to DevTools:", e.message);
            }
          }
        }
      } catch (e) {
        warn("Error during store poll:", e.message);
      }
    }, config.pollIntervalMs);
  }

  function stopStorePolling() {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  }

  // ── Redux DevTools connection (unchanged) ──────────────────────────
  function connectDevTools() {
    if (!window.__REDUX_DEVTOOLS_EXTENSION__) {
      return false;
    }

    try {
      devTools = window.__REDUX_DEVTOOLS_EXTENSION__.connect({
        name: "Odoo POS State",
        features: {
          jump: false,
          skip: false,
          reorder: false,
          dispatch: false,
          persist: false,
        },
      });

      currentState = buildFullSnapshot();
      devTools.init(currentState);

      log("Connected to Redux DevTools");
      return true;
    } catch (e) {
      warn("Failed to connect to Redux DevTools:", e.message);
      return false;
    }
  }

  // ── RAW_SYMBOL discovery (unchanged) ───────────────────────────────
  function discoverRawSymbol() {
    const pos = window.posmodel;
    if (!pos || !pos.models) return false;

    const modelNames = Object.keys(pos.models).filter(
      (k) => typeof pos.models[k] === "object" && pos.models[k] !== null && typeof pos.models[k].getAll === "function"
    );

    for (const name of modelNames) {
      try {
        const records = pos.models[name].getAll();
        if (records && records.length > 0) {
          const sample = records[0];
          const symbols = Object.getOwnPropertySymbols(sample);
          const rawSym = symbols.find((s) => s.description === "raw");
          if (rawSym && sample[rawSym]) {
            RAW_SYMBOL = rawSym;
            log("Discovered RAW_SYMBOL from model:", name);
            return true;
          }
          if (sample.raw && typeof sample.raw === "object") {
            log("RAW_SYMBOL not directly accessible, will use .raw getter fallback");
            return false;
          }
        }
      } catch {
        continue;
      }
    }

    warn("Could not discover RAW_SYMBOL - serialization will use fallback");
    return false;
  }

  // ── Disconnect/Reconnect handling (unchanged) ──────────────────────
  function handleDisconnect() {
    log("POS model disconnected");
    stopStorePolling();

    for (const unsub of unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    unsubscribers = [];

    if (devTools) {
      try {
        devTools.send({ type: "@@DISCONNECT" }, currentState);
      } catch {
        // ignore
      }
    }

    sendStatus({ connected: false, reduxDevTools: !!devTools, posmodelReady: false });

    waitForPosModel();
  }

  // ── Initialization ─────────────────────────────────────────────────
  function initialize() {
    log("POS model detected, initializing...");

    // Discover RAW_SYMBOL
    discoverRawSymbol();

    // Automatically discover all models
    const pos = window.posmodel;
    if (pos && pos.models) {
      config.watchedModels = Object.keys(pos.models).filter(
        name => typeof pos.models[name] === 'object' && pos.models[name] !== null
      );
      log(`Discovered ${config.watchedModels.length} models:`, config.watchedModels);
    }

    // Connect to Redux DevTools
    const devToolsReady = connectDevTools();

    if (!devToolsReady) {
      let retries = 0;
      const retryInterval = setInterval(() => {
        retries++;
        if (connectDevTools() || retries >= 10) {
          clearInterval(retryInterval);
          if (!devTools) {
            warn("Redux DevTools extension not found. Install it from Chrome Web Store.");
          }
          finishInit();
        }
      }, 1000);
    } else {
      finishInit();
    }
  }

  function finishInit() {
    hookModelEvents();
    startStorePolling();

    sendStatus({
      connected: true,
      reduxDevTools: !!devTools,
      posmodelReady: true,
      watchedModels: config.watchedModels,
    });

    log("Initialization complete");
  }

  // ── Wait for posmodel (unchanged) ──────────────────────────────────
  function waitForPosModel() {
    let elapsed = 0;
    const interval = 200;
    const maxWait = 60000;

    sendStatus({ connected: false, reduxDevTools: false, posmodelReady: false });

    const timer = setInterval(() => {
      elapsed += interval;

      if (elapsed > maxWait) {
        clearInterval(timer);
        log("Timeout waiting for window.posmodel");
        sendStatus({ connected: false, reduxDevTools: false, posmodelReady: false, timeout: true });
        return;
      }

      try {
        const pos = window.posmodel;
        if (
          pos &&
          typeof pos === "object" &&
          pos.models &&
          typeof pos.models === "object" &&
          !pos.models._loadingData
        ) {
          clearInterval(timer);
          initialize();
        }
      } catch {
        // Not ready yet
      }
    }, interval);
  }

  // ── Listen for config updates from popup (unchanged) ───────────────
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "ODOO_POS_DEVTOOLS_CONFIG") return;

    const { type, payload } = event.data;

    if (type === "CONFIG_UPDATE" && payload) {
      if (payload.watchedModels) {
        config.watchedModels = payload.watchedModels;
        hookModelEvents();
        if (devTools) {
          currentState = buildFullSnapshot();
          devTools.send({ type: "@@CONFIG_CHANGE", payload: { watchedModels: config.watchedModels } }, currentState);
        }
      }
      if (typeof payload.debounceMs === "number") {
        config.debounceMs = payload.debounceMs;
      }
      if (typeof payload.pollIntervalMs === "number") {
        config.pollIntervalMs = payload.pollIntervalMs;
        startStorePolling();
      }
      log("Config updated:", config);
    }

    if (type === "REFRESH_SNAPSHOT") {
      if (devTools && window.posmodel) {
        currentState = buildFullSnapshot();
        devTools.init(currentState);
        log("Snapshot refreshed");
      }
    }
  });

  // ── Start ──────────────────────────────────────────────────────────
  log("Injected, waiting for POS model...");
  waitForPosModel();
})();