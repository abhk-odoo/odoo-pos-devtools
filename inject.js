/**
 * Odoo POS State Debugger - Injected Page Script (Smart Change Detection)
 * 
 * Runs in the page's JS context with full access to window.posmodel.
 * Intelligently filters noise and shows only meaningful user-driven changes.
 */
(function () {
  "use strict";

  // ── Guard against double injection ──────────────────────────────────
  if (window.__ODOO_POS_DEVTOOLS_INJECTED__) return;
  window.__ODOO_POS_DEVTOOLS_INJECTED__ = true;

  // ── Constants ───────────────────────────────────────────────────────
  const LOG_PREFIX = "[Odoo POS DevTools]";
  const DEFAULT_POLL_INTERVAL = 500;
  const DEFAULT_DEBOUNCE_MS = 300;
  
  // Only track these important store properties
  const IMPORTANT_STORE_KEYS = new Set([
    'openOrder', 'selectedOrder', 'cashier', 'session', 'company', 
    'currency', 'user', 'config', 'orders', 'products', 'partners',
    'taxes', 'fiscalPositions', 'paymentMethods', 'banks'
  ]);

  // Ignore changes to these paths
  const IGNORE_PATHS = [
    /\.lastUpdated$/,
    /\._loading$/,
    /\._syncing$/,
    /\.timestamp$/,
    /\.version$/,
    /\.__/  // Ignore internal properties
  ];

  const MANUAL_GETTERS = [
    'openOrder', 'selectedOrder', 'cashier', 'session', 'company', 'currency',
    'pickingType', 'user', 'config', 'productViewMode', 'showCashMoveButton',
    'printOptions', 'linesToRefund', 'isSelectedLineCombo', 'showSaveOrderButton'
  ];

  // ── Config ─────────────────────────────────────────────────
  let config = {
    watchedModels: [],
    debounceMs: DEFAULT_DEBOUNCE_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL,
  };

  // ── Runtime state ──────────────────────────────────────────────────
  let devTools = null;
  let RAW_SYMBOL = null;
  let currentState = { store: {}, models: {} };
  let previousState = { store: {}, models: {} };
  let pollTimerId = null;
  let pendingSnapshotTimer = null;
  let isInitialized = false;
  
  // Track user activity
  let lastUserAction = Date.now();
  let actionBuffer = [];
  let lastDispatchedActions = [];

  // ── Utility functions ─────────────────────────────────────────────
  function sendStatus(status) {
    window.postMessage(
      { source: "ODOO_POS_DEVTOOLS", type: "STATUS_UPDATE", payload: status },
      "*"
    );
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  // ── Detect user activity ──────────────────────────────────────────
  function setupUserActivityDetection() {
    const events = ['click', 'keydown', 'touchstart', 'mousedown', 'input', 'change'];
    events.forEach(event => {
      document.addEventListener(event, () => {
        lastUserAction = Date.now();
      }, { passive: true });
    });
  }

  function isUserActive() {
    return Date.now() - lastUserAction < 5000; // Consider user active for 5 seconds after last action
  }

  // ── Serialization (optimized) ─────────────────────────────────
  function shouldIgnorePath(path) {
    return IGNORE_PATHS.some(pattern => pattern.test(path));
  }

  function serializeValue(value, depth, maxDepth, visited, path = '') {
    if (value === null || value === undefined) return null;

    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") return value;
    if (type === "function") return "[function]";
    if (type === "bigint") return value.toString();

    if (value instanceof Set) return Array.from(value);
    if (value instanceof Date) return value.toISOString();

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
      const len = Math.min(value.length, 30); // Reduced
      for (let i = 0; i < len; i++) {
        const itemPath = `${path}[${i}]`;
        if (!shouldIgnorePath(itemPath)) {
          result.push(serializeValue(value[i], depth + 1, maxDepth, visited, itemPath));
        }
      }
      if (value.length > 30) result.push(`... +${value.length - 30} more`);
      return result;
    }

    if (typeof value === "object") {
      if (visited.has(value)) return "[circular]";
      visited.add(value);

      if (RAW_SYMBOL && value[RAW_SYMBOL]) {
        return serializeRawObject(value[RAW_SYMBOL], depth + 1, maxDepth, visited, path);
      }

      const result = {};
      try {
        const keys = Object.keys(value).slice(0, 50); // Reduced
        for (const key of keys) {
          if (key.startsWith("__lazy")) continue;
          const newPath = path ? `${path}.${key}` : key;
          if (!shouldIgnorePath(newPath)) {
            try {
              result[key] = serializeValue(value[key], depth + 1, maxDepth, visited, newPath);
            } catch {
              result[key] = "[error reading]";
            }
          }
        }
      } catch {
        return "[unserializable object]";
      }
      return result;
    }

    return String(value);
  }

  function serializeRawObject(raw, depth, maxDepth, visited, path) {
    if (!raw || typeof raw !== "object") return raw;
    if (visited.has(raw)) return "[circular]";
    visited.add(raw);

    const result = {};
    try {
      const keys = Object.keys(raw).slice(0, 30);
      for (const key of keys) {
        const newPath = path ? `${path}.${key}` : key;
        if (!shouldIgnorePath(newPath)) {
          try {
            result[key] = serializeValue(raw[key], depth, maxDepth, visited, newPath);
          } catch {
            result[key] = "[error reading]";
          }
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
        data = serializeRawObject(record[RAW_SYMBOL], 0, 2, visited, '');
      } else if (record.raw && typeof record.raw === "object") {
        data = serializeRawObject(record.raw, 0, 2, visited, '');
      } else {
        data = serializeValue(record, 0, 2, visited, '');
      }
      return data;
    } catch (e) {
      return { _error: e.message };
    }
  }

  // ── Store snapshot (filtered) ────────────────────────────────────
  function snapshotStoreProperties() {
    const pos = window.posmodel;
    if (!pos) return {};

    const snapshot = {};

    // Only track important store properties
    for (const key of IMPORTANT_STORE_KEYS) {
      try {
        if (key in pos) {
          const value = pos[key];
          if (typeof value !== 'function') {
            snapshot[key] = serializeValue(value, 0, 2, new WeakSet(), key);
          }
        }
      } catch (e) {
        snapshot[key] = "[error]";
      }
    }

    // Add important getters
    for (const getter of MANUAL_GETTERS) {
      try {
        if (IMPORTANT_STORE_KEYS.has(getter)) {
          const value = pos[getter];
          if (value !== undefined) {
            snapshot[getter] = serializeValue(value, 0, 2, new WeakSet(), getter);
          }
        }
      } catch (e) {
        snapshot[getter] = "[error]";
      }
    }

    return snapshot;
  }

  function buildModelSnapshot(modelName) {
    const pos = window.posmodel;
    if (!pos || !pos.models || !pos.models[modelName]) return {};

    const model = pos.models[modelName];
    const records = {};
    let count = 0;

    try {
      const allRecords = model.getAll ? model.getAll() : [];
      const maxRecords = 100; // Reduced
      for (const record of allRecords) {
        if (count >= maxRecords) break;
        const id = String(record.id);
        
        // Only include records modified recently or important ones
        if (isRecordImportant(record)) {
          records[id] = serializeRecord(record);
          count++;
        }
      }
    } catch (e) {
      // Silent fail
    }

    return records;
  }

  function isRecordImportant(record) {
    // Add logic to determine if record is important
    // For example, recently modified, active, etc.
    return true; // For now, include all but with limits
  }

  function buildFullSnapshot() {
    const storeSnapshot = snapshotStoreProperties();
    const modelsSnapshot = {};

    const maxModels = 10; // Reduced
    const modelsToSnapshot = config.watchedModels.slice(0, maxModels);
    
    for (const modelName of modelsToSnapshot) {
      // Only snapshot important models
      if (isImportantModel(modelName)) {
        modelsSnapshot[modelName] = buildModelSnapshot(modelName);
      }
    }

    return { store: storeSnapshot, models: modelsSnapshot };
  }

  function isImportantModel(modelName) {
    const importantModels = [
      'order', 'product', 'partner', 'payment', 'cashier', 'session',
      'order.line', 'product.product', 'res.partner', 'pos.order'
    ];
    return importantModels.some(imp => modelName.toLowerCase().includes(imp.toLowerCase()));
  }

  // ── Smart Change Detection ─────────────────────────────────────
  function isSignificantChange(change) {
    // Ignore changes to noisy paths
    if (shouldIgnorePath(change.path)) return false;
    
    // Ignore value changes that are just timers/counters
    if (change.type === 'VALUE_CHANGE') {
      // If it's a number change by 1, likely a counter
      if (typeof change.oldValue === 'number' && typeof change.newValue === 'number') {
        if (Math.abs(change.newValue - change.oldValue) === 1) {
          // Check if it's in a noisy path
          if (change.path.includes('count') || change.path.includes('index') || 
              change.path.includes('offset') || change.path.includes('page')) {
            return false;
          }
        }
      }
      
      // Ignore timestamp changes
      if (change.path.includes('time') || change.path.includes('date') || 
          change.path.includes('updated') || change.path.includes('created')) {
        return false;
      }
    }
    
    return true;
  }

  function detectChanges(prev, curr, path = '', significantOnly = true) {
    const changes = [];
    
    if (prev === curr) return changes;
    
    if (typeof prev !== 'object' || prev === null || typeof curr !== 'object' || curr === null) {
      const change = {
        path: path || 'root',
        type: 'VALUE_CHANGE',
        oldValue: prev,
        newValue: curr
      };
      
      if (!significantOnly || isSignificantChange(change)) {
        changes.push(change);
      }
      return changes;
    }

    // Handle arrays
    if (Array.isArray(prev) && Array.isArray(curr)) {
      if (prev.length !== curr.length) {
        const change = {
          path,
          type: 'ARRAY_LENGTH_CHANGE',
          oldLength: prev.length,
          newLength: curr.length
        };
        if (!significantOnly || isSignificantChange(change)) {
          changes.push(change);
        }
      }
    }

    // Handle objects
    try {
      const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
      
      for (const key of allKeys) {
        const newPath = path ? `${path}.${key}` : key;
        if (shouldIgnorePath(newPath)) continue;
        
        if (!(key in prev)) {
          const change = {
            path: newPath,
            type: 'PROPERTY_ADDED',
            newValue: curr[key]
          };
          if (!significantOnly || isSignificantChange(change)) {
            changes.push(change);
          }
        } else if (!(key in curr)) {
          const change = {
            path: newPath,
            type: 'PROPERTY_REMOVED',
            oldValue: prev[key]
          };
          if (!significantOnly || isSignificantChange(change)) {
            changes.push(change);
          }
        } else {
          const nestedChanges = detectChanges(prev[key], curr[key], newPath, significantOnly);
          changes.push(...nestedChanges);
        }
      }
    } catch (e) {
      // Ignore comparison errors
    }
    
    return changes;
  }

  function identifyModelChanges(prevModels, currModels) {
    const modelChanges = [];
    
    for (const modelName of config.watchedModels.slice(0, 10)) {
      const prev = prevModels[modelName] || {};
      const curr = currModels[modelName] || {};
      
      // Only track changes if there's user activity or it's a major change
      if (!isUserActive() && Object.keys(curr).length === Object.keys(prev).length) {
        continue;
      }
      
      const prevIds = new Set(Object.keys(prev).filter(k => !k.startsWith('_')));
      const currIds = new Set(Object.keys(curr).filter(k => !k.startsWith('_')));
      
      // Detect created records (only if user is active)
      for (const id of currIds) {
        if (!prevIds.has(id) && isUserActive()) {
          modelChanges.push({
            type: `${modelName}/CREATED`,
            payload: { id, record: curr[id] }
          });
        }
      }
      
      // Detect deleted records
      for (const id of prevIds) {
        if (!currIds.has(id) && isUserActive()) {
          modelChanges.push({
            type: `${modelName}/DELETED`,
            payload: { id, lastKnownData: prev[id] }
          });
        }
      }
      
      // Detect significant updates
      for (const id of currIds) {
        if (prevIds.has(id) && prev[id] && curr[id]) {
          const recordChanges = detectChanges(prev[id], curr[id], id, true); // significant only
          if (recordChanges.length > 0 && isUserActive()) {
            modelChanges.push({
              type: `${modelName}/UPDATED`,
              payload: { 
                id, 
                fields: [...new Set(recordChanges.map(c => c.path.split('.').pop()))],
                changes: recordChanges
              }
            });
          }
        }
      }
    }
    
    return modelChanges;
  }

  function identifyStoreChanges(prevStore, currStore) {
    // Only detect store changes if user is active
    if (!isUserActive()) return null;
    
    const changes = detectChanges(prevStore, currStore, '', true);
    
    if (changes.length === 0) return null;
    
    // Group by property
    const propertyChanges = {};
    changes.forEach(change => {
      const prop = change.path.split('.')[0];
      if (!propertyChanges[prop]) {
        propertyChanges[prop] = [];
      }
      propertyChanges[prop].push(change);
    });
    
    return {
      type: 'STORE/UPDATED',
      payload: {
        properties: Object.keys(propertyChanges),
        changes: propertyChanges,
        totalChanges: changes.length
      }
    };
  }

  // ── State capture with smart filtering ─────────────────────────────
  function captureAndDispatchChanges() {
    if (!window.posmodel || !devTools) return;
    
    try {
      if (window.posmodel.models && window.posmodel.models._loadingData) {
        return;
      }
    } catch {
      return;
    }

    if (pendingSnapshotTimer) {
      clearTimeout(pendingSnapshotTimer);
    }
    
    pendingSnapshotTimer = setTimeout(() => {
      pendingSnapshotTimer = null;
      
      try {
        const newState = buildFullSnapshot();
        const actions = [];
        
        // Only process changes if user is active or it's been a while
        if (isUserActive() || Math.random() < 0.1) { // 10% chance when inactive
          const modelChanges = identifyModelChanges(previousState.models, newState.models);
          actions.push(...modelChanges);
          
          const storeChange = identifyStoreChanges(previousState.store, newState.store);
          if (storeChange) {
            actions.push(storeChange);
          }
        }
        
        // Update state
        previousState = JSON.parse(JSON.stringify(newState));
        currentState = newState;
        
        // Send to DevTools (only if there are actions)
        if (devTools && actions.length > 0) {
          // Debounce similar actions
          const actionKey = actions.map(a => a.type).join('|');
          const now = Date.now();
          
          // Clear old actions
          lastDispatchedActions = lastDispatchedActions.filter(t => now - t.time < 2000);
          
          // Check if we've seen similar actions recently
          const similarRecent = lastDispatchedActions.some(t => t.key === actionKey);
          
          if (!similarRecent) {
            lastDispatchedActions.push({ key: actionKey, time: now });
            
            if (actions.length === 1) {
              devTools.send(actions[0], currentState);
            } else {
              // Batch multiple changes
              devTools.send({
                type: 'BATCHED_UPDATES',
                payload: { 
                  timestamp: now,
                  count: actions.length,
                  actions: actions.map(a => ({ type: a.type, ...a.payload }))
                }
              }, currentState);
            }
            
            // Log to console for easy debugging
            console.group(`${LOG_PREFIX} State Changes Detected`);
            actions.forEach(a => {
              console.log(`🔵 ${a.type}`, a.payload);
            });
            console.groupEnd();
          }
        }
        
      } catch (e) {
        // Silent fail to avoid console spam
      }
    }, config.debounceMs);
  }

  // ── Rest of the code (polling, connection, etc.) ─────────────────
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
    
    try {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!deepEqual(a[key], b[key])) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  function startStorePolling() {
    stopStorePolling();
    
    try {
      previousState = buildFullSnapshot();
      currentState = JSON.parse(JSON.stringify(previousState));
    } catch (e) {
      // Silent fail
    }

    pollTimerId = setInterval(() => {
      if (document.hidden || !window.posmodel || !devTools) return;
      captureAndDispatchChanges();
    }, config.pollIntervalMs);
  }

  function stopStorePolling() {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
    if (pendingSnapshotTimer) {
      clearTimeout(pendingSnapshotTimer);
      pendingSnapshotTimer = null;
    }
  }

  function connectDevTools() {
    if (!window.__REDUX_DEVTOOLS_EXTENSION__) return false;

    try {
      devTools = window.__REDUX_DEVTOOLS_EXTENSION__.connect({
        name: "Odoo POS (Smart Debug)",
        features: {
          jump: false,
          skip: false,
          reorder: false,
          dispatch: false,
          persist: false,
          lock: true,
        },
        lock: true,
      });

      previousState = buildFullSnapshot();
      currentState = JSON.parse(JSON.stringify(previousState));
      devTools.init(currentState);

      log("Connected to Redux DevTools");
      return true;
    } catch (e) {
      return false;
    }
  }

  function discoverRawSymbol() {
    const pos = window.posmodel;
    if (!pos || !pos.models) return false;

    const modelNames = Object.keys(pos.models).filter(
      (k) => typeof pos.models[k] === "object" && pos.models[k] !== null && typeof pos.models[k].getAll === "function"
    );

    for (const name of modelNames.slice(0, 3)) {
      try {
        const records = pos.models[name].getAll();
        if (records && records.length > 0) {
          const sample = records[0];
          const symbols = Object.getOwnPropertySymbols(sample);
          const rawSym = symbols.find((s) => s.description === "raw");
          if (rawSym && sample[rawSym]) {
            RAW_SYMBOL = rawSym;
            return true;
          }
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  function handleDisconnect() {
    stopStorePolling();
    if (devTools) {
      try {
        devTools.send({ type: "@@DISCONNECT" }, currentState);
      } catch {}
    }
    sendStatus({ connected: false, reduxDevTools: !!devTools, posmodelReady: false });
    isInitialized = false;
    waitForPosModel();
  }

  function initialize() {
    if (isInitialized) return;
    log("Initializing smart debugger...");

    const pos = window.posmodel;
    if (pos && pos.models) {
      config.watchedModels = Object.keys(pos.models).filter(
        name => typeof pos.models[name] === 'object' && pos.models[name] !== null
      );
    }

    discoverRawSymbol();
    setupUserActivityDetection();

    const devToolsReady = connectDevTools();

    if (!devToolsReady) {
      let retries = 0;
      const retryInterval = setInterval(() => {
        retries++;
        if (connectDevTools() || retries >= 5) {
          clearInterval(retryInterval);
          finishInit();
        }
      }, 1000);
    } else {
      finishInit();
    }
  }

  function finishInit() {
    isInitialized = true;
    startStorePolling();

    sendStatus({
      connected: true,
      reduxDevTools: !!devTools,
      posmodelReady: true,
    });

    log("Smart debugger ready - will only show user-driven changes");
  }

  function waitForPosModel() {
    let elapsed = 0;
    const interval = 500;
    const maxWait = 30000;

    sendStatus({ connected: false, reduxDevTools: false, posmodelReady: false });

    const timer = setInterval(() => {
      elapsed += interval;

      if (elapsed > maxWait) {
        clearInterval(timer);
        return;
      }

      try {
        const pos = window.posmodel;
        if (pos && pos.models && typeof pos.models === "object" && !pos.models._loadingData) {
          clearInterval(timer);
          initialize();
        }
      } catch {}
    }, interval);
  }

  // ── Listen for config updates ────────────────────────────────
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "ODOO_POS_DEVTOOLS_CONFIG") return;

    const { type, payload } = event.data;

    if (type === "CONFIG_UPDATE" && payload) {
      if (payload.pollIntervalMs && payload.pollIntervalMs >= 500) {
        config.pollIntervalMs = payload.pollIntervalMs;
        if (isInitialized) startStorePolling();
      }
    }

    if (type === "REFRESH_SNAPSHOT" && devTools && window.posmodel) {
      currentState = buildFullSnapshot();
      previousState = JSON.parse(JSON.stringify(currentState));
      devTools.init(currentState);
      log("Snapshot refreshed");
    }
  });

  // ── Start ─────────────────────────────────────────────────────────
  log("Smart debugger injected - will filter noise");
  waitForPosModel();
})();