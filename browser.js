'use strict';

const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

// Modulweite Konfiguration/State
let cdpHost = '127.0.0.1';
let cdpPort = 9222;
let chromeProc = null;
let readyPromise = null;

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

function initBrowser({ host = '127.0.0.1', port = 9222 } = {}) {
  cdpHost = host;
  cdpPort = port;

  const CHROME_BIN = getChromeBin();
  if (!CHROME_BIN) {
    throw new Error(
      'No Chrome/Chromium binary found. Set CHROME_BIN or install chromium/google-chrome.'
    );
  }

  const userDataDir = `/tmp/dishy-chrome-${process.pid}`;
  const chromeArgs = [
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
    if (chromeProc && !chromeProc.killed) {
      try { chromeProc.kill('SIGKILL'); } catch (_) {}
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  readyPromise = waitForCDPReady();
  return readyPromise;
}

/**
 * Führt einen CDP-Befehl auf dem Browser-WebSocket aus und liefert das result zurück.
 */
async function browserWsCommand(method, params = {}, { timeoutMs = 15000 } = {}) {
  await (readyPromise || waitForCDPReady());

  const versionRes = await fetch(`http://${cdpHost}:${cdpPort}/json/version`);
  if (!versionRes.ok) throw new Error(`CDP version request failed: ${versionRes.status}`);
  const versionInfo = await versionRes.json();
  const browserWsUrl = versionInfo.webSocketDebuggerUrl;
  if (!browserWsUrl) throw new Error('Browser WebSocket URL not found.');

  const ws = new WebSocket(browserWsUrl);
  let nextId = 1;
  const inflight = new Map();

  function send(cmd, args = {}) {
    const id = nextId++;
    const msg = { id, method: cmd, params: args };
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`WebSocket not open: readyState ${ws.readyState}`));
      }
      inflight.set(id, { resolve, reject });
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          inflight.delete(id);
          reject(err);
        }
      });
    });
  }

  const onMessage = (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && inflight.has(msg.id)) {
        const { resolve } = inflight.get(msg.id);
        inflight.delete(msg.id);
        resolve(msg.result);
      }
    } catch (_) {}
  };

  const onClose = () => {
    for (const { reject } of inflight.values()) reject(new Error('Browser CDP WebSocket closed.'));
    inflight.clear();
  };

  const openPromise = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', (err) => reject(new Error(`WebSocket connection failed: ${err.message}`)));
  });

  ws.on('message', onMessage);
  ws.on('close', onClose);

  let timer;
  try {
    await openPromise;

    // Timer erst NACH erfolgreichem Öffnen starten
    timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
    }, timeoutMs);

    const result = await send(method, params);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    try { ws.close(); } catch (_) {}
  }
}

/**
 * CDP Target erstellen: per Browser-WS Target.createTarget und dann /json/list abfragen.
 */
async function cdpCreateTarget(url) {
  const { targetId } = await browserWsCommand('Target.createTarget', { url });
  if (!targetId) throw new Error('Target.createTarget: did not receive targetId');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const listRes = await fetch(`http://${cdpHost}:${cdpPort}/json/list`);
    if (listRes.ok) {
      const arr = await listRes.json();
      const found = arr.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
      if (found) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('webSocketDebuggerUrl for new target not found.');
}

/**
 * CDP Target schließen: per Browser-WS Target.closeTarget
 */
async function cdpCloseTarget(id) {
  try {
    await browserWsCommand('Target.closeTarget', { targetId: id });
  } catch (_) {
    // ignore
  }
}

/**
 * Aus dem Target über CDP den Text aus <div class="Json-Text"> lesen, bis vorhanden.
 */
async function cdpExtractJsonFromTarget(wsUrl, { timeoutMs = 20000, pollMs = 200 } = {}) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const inflight = new Map();

  function send(method, params = {}) {
    const id = nextId++;
    const msg = { id, method, params };
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`WebSocket not open: readyState ${ws.readyState}`));
      }
      inflight.set(id, { resolve, reject });
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          inflight.delete(id);
          reject(err);
        }
      });
    });
  }

  const onMessage = (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && inflight.has(msg.id)) {
        const { resolve } = inflight.get(msg.id);
        inflight.delete(msg.id);
        resolve(msg.result);
      }
    } catch (_) {}
  };

  const onClose = () => {
    for (const { reject } of inflight.values()) reject(new Error('CDP WebSocket geschlossen.'));
    inflight.clear();
  };

  const openPromise = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', (err) => reject(new Error(`WebSocket connection failed: ${err.message}`)));
  });

  ws.on('message', onMessage);
  ws.on('close', onClose);

  let timer;
  try {
    await openPromise;

    // Timer erst NACH erfolgreichem Öffnen starten
    timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
    }, timeoutMs);

    await send('Runtime.enable');
    await send('Page.enable');

    // Warte auf Page.loadEventFired
    let loadFired = false;
    const loadPromise = new Promise((resolve) => {
      const originalOnMessage = ws.listeners('message')[0];
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.method === 'Page.loadEventFired') {
            loadFired = true;
            resolve();
          }
        } catch (_) {}
      });
    });

    // Warte max 10s auf Load-Event
    await Promise.race([loadPromise, new Promise((r) => setTimeout(r, 10000))]);
    console.log(`[DEBUG] Page load event fired: ${loadFired}`);

    const expr = `(function(){
      const el = document.querySelector('.Json-Text');
      return {
        found: !!el,
        textContent: el ? el.textContent : null,
        innerHTML: el ? el.innerHTML : null,
        bodyLength: document.body ? document.body.innerHTML.length : 0,
        allJsonTextElements: document.querySelectorAll('.Json-Text').length
      };
    })()`;

    const end = Date.now() + timeoutMs;
    let lastDebugInfo = null;
    while (Date.now() < end) {
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      const debugInfo = res && res.result && res.result.value ? res.result.value : {};
      lastDebugInfo = debugInfo;

      console.log(`[DEBUG] Element found: ${debugInfo.found}, textContent length: ${debugInfo.textContent?.length || 0}, innerHTML length: ${debugInfo.innerHTML?.length || 0}, body length: ${debugInfo.bodyLength}, .Json-Text elements: ${debugInfo.allJsonTextElements}`);

      const text = debugInfo.textContent || debugInfo.innerHTML || '';
      const trimmed = String(text).trim();

      if (trimmed) {
        try {
          return JSON.parse(trimmed);
        } catch {
          const m = trimmed.match(/\{[\s\S]*\}$/);
          if (m) {
            try { return JSON.parse(m[0]); } catch (_) {}
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    const errorMsg = lastDebugInfo
      ? `No .Json-Text found: element=${lastDebugInfo.found}, textLength=${lastDebugInfo.textContent?.length || 0}, htmlLength=${lastDebugInfo.innerHTML?.length || 0}, bodyLength=${lastDebugInfo.bodyLength}, elements=${lastDebugInfo.allJsonTextElements}`
      : 'Timeout: JSON nicht gefunden.';
    throw new Error(errorMsg);
  } finally {
    if (timer) clearTimeout(timer);
    try { ws.close(); } catch (_) {}
  }
}

module.exports = {
  initBrowser,
  cdpCreateTarget,
  cdpCloseTarget,
  cdpExtractJsonFromTarget
};

