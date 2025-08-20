const http = require('http');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8055;
const DISHY_ADDRESS = process.env.DISHY_ADDRESS || 'http://192.168.100.1';
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.CDP_PORT) || 9222;

/**
 * Versucht eine lauffähige Chrome/Chromium-Binary zu finden.
 * Reihenfolge: CHROME_BIN env, dann gängige Binärnamen.
 */
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
		'microsoft-edge',
	].filter(Boolean);

	for (const bin of candidates) {
		try {
			const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
			if (r && r.status === 0) {
				return bin;
			}
		} catch (_) {
			// ignore and try next
		}
	}
	return null;
}

const CHROME_BIN = getChromeBin();
if (!CHROME_BIN) {
	throw new Error(
		'Keine Chrome/Chromium-Binary gefunden. Setze CHROME_BIN oder installiere chromium/google-chrome.',
	);
}

// Persistent Headless-Chrome starten (einmalig)
const userDataDir = `/tmp/dishy-chrome-${process.pid}`;
const chromeArgs = [
	`--remote-debugging-port=${CDP_PORT}`,
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
	'--hide-scrollbars',
];
const chromeProc = spawn(CHROME_BIN, chromeArgs, { stdio: ['ignore', 'ignore', 'inherit'] });

// Aufräumen
function cleanup() {
	if (chromeProc && !chromeProc.killed) {
		try {
			chromeProc.kill('SIGKILL');
		} catch (_) {
		}
	}
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
	cleanup();
	process.exit(0);
});
process.on('SIGTERM', () => {
	cleanup();
	process.exit(0);
});

// Warten, bis CDP bereit ist
async function waitForCDPReady(timeoutMs = 10000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		try {
			const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
			if (res.ok) {
				return;
			}
		} catch (_) {
		}
		await new Promise(r => setTimeout(r, 200));
	}
	throw new Error('CDP nicht erreichbar.');
}

let cdpReadyPromise = waitForCDPReady();

/**
 * Führt einen CDP-Befehl auf dem Browser-WebSocket aus und liefert das result zurück.
 */
async function browserWsCommand(method, params = {}, { timeoutMs = 8000 } = {}) {
	await cdpReadyPromise;

	// Hole Browser-WebSocket-URL
	const versionRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
	if (!versionRes.ok) {
		throw new Error(`CDP Version fehlgeschlagen: ${versionRes.status}`);
	}
	const versionInfo = await versionRes.json();
	const browserWsUrl = versionInfo.webSocketDebuggerUrl;
	if (!browserWsUrl) {
		throw new Error('Browser WebSocket URL nicht gefunden.');
	}

	const ws = new WebSocket(browserWsUrl);
	let nextId = 1;
	const inflight = new Map();

	function send(cmd, args = {}) {
		const id = nextId++;
		const msg = { id, method: cmd, params: args };
		return new Promise((resolve, reject) => {
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
		} catch (_) {
		}
	};

	const onClose = () => {
		for (const { reject } of inflight.values()) {
			reject(new Error('Browser CDP WebSocket geschlossen.'));
		}
		inflight.clear();
	};

	const openPromise = new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});

	const timer = setTimeout(() => {
		try {
			ws.close();
		} catch (_) {
		}
	}, timeoutMs);

	ws.on('message', onMessage);
	ws.on('close', onClose);

	try {
		await openPromise;
		const result = await send(method, params);
		return result;
	} finally {
		clearTimeout(timer);
		try {
			ws.close();
		} catch (_) {
		}
	}
}

/**
 * CDP Target erstellen: per Browser-WS Target.createTarget und dann /json/list abfragen.
 */
async function cdpCreateTarget(url) {
	const { targetId } = await browserWsCommand('Target.createTarget', { url });
	if (!targetId) {
		throw new Error('Target.createTarget: keine targetId erhalten');
	}

	// webSocketDebuggerUrl finden (kurz pollen)
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const listRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
		if (listRes.ok) {
			const arr = await listRes.json();
			const found = arr.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
			if (found) {
				return found;
			} // { id, webSocketDebuggerUrl, ... }
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('webSocketDebuggerUrl für neues Target nicht gefunden.');
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
async function cdpExtractJsonFromTarget(wsUrl, { timeoutMs = 10000, pollMs = 200 } = {}) {
	const ws = new WebSocket(wsUrl);
	let nextId = 1;
	const inflight = new Map();

	function send(method, params = {}) {
		const id = nextId++;
		const msg = { id, method, params };
		return new Promise((resolve, reject) => {
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
		} catch (_) {
		}
	};

	const onClose = () => {
		for (const { reject } of inflight.values()) {
			reject(new Error('CDP WebSocket geschlossen.'));
		}
		inflight.clear();
	};

	const openPromise = new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});

	ws.on('message', onMessage);
	ws.on('close', onClose);

	const timer = setTimeout(() => {
		try {
			ws.close();
		} catch (_) {
		}
	}, timeoutMs);

	try {
		await openPromise;
		await send('Runtime.enable');

		const expr = `(function(){
      const el = document.querySelector('.Json-Text');
      return el ? el.textContent : '';
    })()`;

		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
			const text = res && res.result && res.result.value ? String(res.result.value).trim() : '';
			if (text) {
				// JSON parsen (mit einfachem Fallback auf letzten {…}-Block)
				try {
					return JSON.parse(text);
				} catch {
					const m = text.match(/\{[\s\S]*\}$/);
					if (m) {
						try {
							return JSON.parse(m[0]);
						} catch (_) {
						}
					}
				}
			}
			await new Promise(r => setTimeout(r, pollMs));
		}
		throw new Error('Timeout: JSON nicht gefunden.');
	} finally {
		clearTimeout(timer);
		try {
			ws.close();
		} catch (_) {
		}
	}
}

const server = http.createServer(async (req, res) => {
	// Nur GET erlauben
	if (req.method !== 'GET') {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
	}

	const url = new URL(req.url, `http://${req.headers.host}`);

	if (url.pathname === '/metrics') {
		// JSON der Dishy-Seite via persistentem Headless-Chrome (CDP) holen und zurückgeben
		try {
			const target = await cdpCreateTarget(DISHY_ADDRESS);
			const { id, webSocketDebuggerUrl } = target;
			let data;
			try {
				data = await cdpExtractJsonFromTarget(webSocketDebuggerUrl, {
					timeoutMs: Number(url.searchParams.get('timeoutMs')) || 10000,
					pollMs: Number(url.searchParams.get('pollMs')) || 200,
				});
			} finally {
				if (id) {
					await cdpCloseTarget(id);
				}
			}

			if (!data) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				return res.end(
					JSON.stringify({
									   error: 'Dishy JSON im DOM nicht gefunden',
									   hint: 'Prüfe Erreichbarkeit oder erhöhe timeoutMs.',
								   }),
				);
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify(data, null, 2));
		} catch (e) {
			console.error('CDP-Fehler:', e && e.message ? e.message : e);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			return res.end(
				JSON.stringify({
								   error: 'Headless-Session fehlgeschlagen',
								   message: e && e.message ? e.message : String(e),
							   }),
			);
		}
	}

	if (url.pathname === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		return res.end(
			JSON.stringify({
							   status: 'ok',
							   uptime: process.uptime(),
							   timestamp: new Date().toISOString(),
						   }),
		);
	}

	// 404 für alle anderen GET-Routen
	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
	console.log(`Server lauscht auf http://localhost:${PORT}`);
});
