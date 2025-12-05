'use strict';

const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

// Modulweite Konfiguration/State
let cdpHost = '127.0.0.1';
let cdpPort = 9222;
let chromeProc = null;
let readyPromise = null;
let persistentWs = null;
let persistentTarget = null;
let nextId = 1;
const inflight = new Map();
let changeListenerRegistered = false;
let onJsonChangeResolve = null;
let changeEventCounter = 0;

function getChromeBin() {
  const candidates = [
    process.env.CHROME_BIN,
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
    'google-chrome-beta',
    'chrome',
    'msedge',
    'microsoft-edge'
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
      if (r && r.status === 0) return bin;
    } catch (_) {}
  }
  return null;
}

async function waitForCDPReady(timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://${cdpHost}:${cdpPort}/json/version`);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('CDP not reachable.');
}

async function initBrowser({ host = '127.0.0.1', port = 9222, dishyUrl = 'http://dishy.starlink.com/' } = {}) {
  cdpHost = host;
  cdpPort = port;

  const CHROME_BIN = getChromeBin();
  if (!CHROME_BIN) {
    throw new Error(
      'No Chrome/Chromium binary found. Set CHROME_BIN or install chromium/google-chrome.'
    );
  }

  const userDataDir = process.env.CHROME_USER_DATA_DIR || `/tmp/dishy-chrome-${process.pid}`;
  const chromeArgs = [
    '--remote-debugging-address=0.0.0.0',
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${userDataDir}`,
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-first-run',
    '--mute-audio',
    '--hide-scrollbars'
  ];

  chromeProc = spawn(CHROME_BIN, chromeArgs, { stdio: ['ignore', 'ignore', 'inherit'] });

  const cleanup = () => {
    if (persistentWs) {
      try { persistentWs.close(); } catch (_) {}
    }
    if (chromeProc && !chromeProc.killed) {
      try { chromeProc.kill('SIGKILL'); } catch (_) {}
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  readyPromise = waitForCDPReady();
  await readyPromise;

  // Persistente Seite laden
  console.log('[Browser] Erstelle persistentes Target für:', dishyUrl);
  persistentTarget = await cdpCreateTarget(dishyUrl);

  // Persistente WebSocket-Verbindung öffnen
  persistentWs = new WebSocket(persistentTarget.webSocketDebuggerUrl);

  const openPromise = new Promise((resolve, reject) => {
    persistentWs.once('open', resolve);
    persistentWs.once('error', reject);
  });

  persistentWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && inflight.has(msg.id)) {
        const { resolve } = inflight.get(msg.id);
        inflight.delete(msg.id);
        resolve(msg.result);
      }
    } catch (_) {}
  });

  persistentWs.on('close', () => {
    console.log('[Browser] Persistente WebSocket geschlossen.');
    for (const { reject } of inflight.values()) {
      reject(new Error('Persistente WebSocket geschlossen.'));
    }
    inflight.clear();
  });

  await openPromise;
  console.log('[Browser] WebSocket geöffnet, aktiviere Runtime...');

  await sendToPersistent('Runtime.enable');
  await sendToPersistent('Page.enable');
  await sendToPersistent('Debugger.enable');

  // Permanenter Page-Load-Listener: triggert Initialisierung bei jedem Page-Load
  persistentWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.method === 'Page.loadEventFired') {
        initializePageListener();
      }
    } catch (_) {}
  });

  // Warte auf ersten Page-Load
  const loadPromise = new Promise((resolve) => {
    const handler = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.method === 'Page.loadEventFired') {
          persistentWs.off('message', handler);
          resolve();
        }
      } catch (_) {}
    };
    persistentWs.on('message', handler);
  });

  await Promise.race([loadPromise, new Promise((r) => setTimeout(r, 15000))]);

  // Initialisierung wird jetzt über Page-Load-Listener getriggert
  console.log('[Browser] Browser bereit.');
}

/**
 * Sendet einen CDP-Befehl an die persistente WebSocket-Verbindung
 */
function sendToPersistent(method, params = {}) {
  const id = nextId++;
  const msg = { id, method, params };
  return new Promise((resolve, reject) => {
    if (!persistentWs || persistentWs.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Persistente WebSocket nicht bereit: readyState ${persistentWs?.readyState}`));
    }
    inflight.set(id, { resolve, reject });
    persistentWs.send(JSON.stringify(msg), (err) => {
      if (err) {
        inflight.delete(id);
        reject(err);
      }
    });
  });
}

/**
 * Führt einen CDP-Befehl auf dem Browser-WebSocket aus (für Target.createTarget)
 */
async function browserWsCommand(method, params = {}) {
  await (readyPromise || waitForCDPReady());

  const versionRes = await fetch(`http://${cdpHost}:${cdpPort}/json/version`);
  if (!versionRes.ok) throw new Error(`CDP version request failed: ${versionRes.status}`);
  const versionInfo = await versionRes.json();
  const browserWsUrl = versionInfo.webSocketDebuggerUrl;
  if (!browserWsUrl) throw new Error('Browser WebSocket URL not found.');

  const ws = new WebSocket(browserWsUrl);
  let cmdId = 1;
  const cmdInflight = new Map();

  function send(cmd, args = {}) {
    const id = cmdId++;
    const msg = { id, method: cmd, params: args };
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`WebSocket not open: readyState ${ws.readyState}`));
      }
      cmdInflight.set(id, { resolve, reject });
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          cmdInflight.delete(id);
          reject(err);
        }
      });
    });
  }

  const onMessage = (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && cmdInflight.has(msg.id)) {
        const { resolve } = cmdInflight.get(msg.id);
        cmdInflight.delete(msg.id);
        resolve(msg.result);
      }
    } catch (_) {}
  };

  const onClose = () => {
    for (const { reject } of cmdInflight.values()) reject(new Error('Browser CDP WebSocket closed.'));
    cmdInflight.clear();
  };

  const openPromise = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', (err) => reject(new Error(`WebSocket connection failed: ${err.message}`)));
  });

  ws.on('message', onMessage);
  ws.on('close', onClose);

  try {
    await openPromise;
    const result = await send(method, params);
    return result;
  } finally {
    try { ws.close(); } catch (_) {}
  }
}

/**
 * CDP Target erstellen: per Browser-WS Target.createTarget und dann /json/list abfragen.
 */
async function cdpCreateTarget(url) {
  console.log(`[DEBUG] Creating target for URL: ${url}`);
  const { targetId } = await browserWsCommand('Target.createTarget', { url });
  if (!targetId) throw new Error('Target.createTarget: did not receive targetId');
  console.log(`[DEBUG] Target created with ID: ${targetId}`);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const listRes = await fetch(`http://${cdpHost}:${cdpPort}/json/list`);
    if (listRes.ok) {
      const arr = await listRes.json();
      const found = arr.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
      if (found) {
        console.log(`[DEBUG] Target ready with WebSocket URL: ${found.webSocketDebuggerUrl}`);
        return found;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('webSocketDebuggerUrl for new target not found.');
}


/**
 * Wartet bis .Json-Text Element existiert und Inhalt hat
 */
async function waitForJsonElement(maxWaitMs = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const expr = `(function(){
      const el = document.querySelector('.Json-Text');
      return el && (el.textContent || el.innerHTML) ? true : false;
    })()`;
    const res = await sendToPersistent('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (res?.result?.value === true) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('JSON-Element nicht gefunden nach ' + maxWaitMs + 'ms');
}

/**
 * Führt Initialisierung nach Page-Load aus:
 * Wartet auf JSON-Element, registriert Change-Listener, pausiert Debugger
 */
async function initializePageListener() {
  try {
    console.log('[Browser] Page geladen, warte auf JSON...');
    await waitForJsonElement();
    console.log('[Browser] JSON gefunden, registriere Change-Listener...');

    changeEventCounter = 0;
    changeListenerRegistered = false; // Reset für Neuregistrierung
    await registerJsonChangeListener();

    await sendToPersistent('Debugger.pause');
    console.log('[Browser] Debugger pausiert, bereit für Metrics.');
  } catch (err) {
    console.error('[Browser] Fehler bei Page-Initialisierung:', err.message);
  }
}

/**
 * Registriert einen MutationObserver auf .Json-Text Element (einmalig)
 */
async function registerJsonChangeListener() {
  if (changeListenerRegistered) {
    console.log('[Browser] Change-Listener bereits registriert.');
    return;
  }

  // Event-Handler für Runtime.consoleAPICalled registrieren
  persistentWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = msg.params?.args || [];
        if (args.length > 0 && args[0].value === '__JSON_CHANGED__') {
          changeEventCounter++;
          if (onJsonChangeResolve) {
            onJsonChangeResolve();
          }
        }
      }
    } catch (_) {}
  });

  await sendToPersistent('Runtime.enable');

  const observerScript = `
    (function() {
      const target = document.querySelector('.Json-Text');
      if (!target) {
        console.log('__JSON_OBSERVER_ERROR__');
        return;
      }
      const observer = new MutationObserver(() => {
        console.log('__JSON_CHANGED__');
      });
      observer.observe(target, { childList: true, characterData: true, subtree: true });
      console.log('__JSON_OBSERVER_REGISTERED__');
    })();
  `;

  await sendToPersistent('Runtime.evaluate', { expression: observerScript });
  changeListenerRegistered = true;
  console.log('[Browser] MutationObserver auf .Json-Text registriert.');
}

/**
 * Liest JSON aus der bereits geöffneten Seite aus <div class="Json-Text">
 * Reaktiviert Debugger, wartet auf 2 DOM-Changes, liest aus, pausiert Debugger wieder
 */
async function extractJsonFromPage() {
  // 1. Aktuellen Counter merken und Debugger fortsetzen
  const initialCounter = changeEventCounter;
  const targetCounter = initialCounter + 2;
  await sendToPersistent('Debugger.resume');

  // 2. Auf 2 DOM-Changes warten (max 10 Sekunden)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      onJsonChangeResolve = null;
      reject(new Error('Timeout: Keine 2 DOM-Changes innerhalb 10 Sekunden'));
    }, 10000);

    onJsonChangeResolve = () => {
      if (changeEventCounter >= targetCounter) {
        clearTimeout(timeout);
        onJsonChangeResolve = null;
        resolve();
      }
    };

    // Falls bereits genug Events da sind
    if (changeEventCounter >= targetCounter) {
      clearTimeout(timeout);
      onJsonChangeResolve = null;
      resolve();
    }
  });

  // 3. JSON auslesen
  const expr = `(function(){
    const el = document.querySelector('.Json-Text');
    return el ? el.textContent || el.innerHTML : null;
  })()`;

  const res = await sendToPersistent('Runtime.evaluate', { expression: expr, returnByValue: true });

  // 4. Debugger wieder pausieren
  await sendToPersistent('Debugger.pause');

  if (!res || !res.result || !res.result.value) {
    throw new Error('Kein .Json-Text Element gefunden.');
  }

  const text = String(res.result.value).trim();
  if (!text) {
    throw new Error('.Json-Text Element ist leer.');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {}
    }
    throw new Error(`JSON Parse-Fehler: ${e.message}`);
  }
}

module.exports = {
  initBrowser,
  extractJsonFromPage
};

