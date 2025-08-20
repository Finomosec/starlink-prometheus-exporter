const http = require('http');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 3001;
const DISHY_ADDRESS = process.env.DISHY_ADDRESS || 'http://192.168.100.1';
const chrome = getChromeBin();
if (!chrome) {
	throw new Error('Keine Chrome/Chromium-Binary gefunden. Setze CHROME_BIN oder installiere chromium/google-chrome.');
}

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

/**
 * Führt headless Chrome/Chromium mit --dump-dom aus und gibt den HTML-String zurück.
 */
function dumpDom(url, { budgetMs = 5000, timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		const args = [
			'--headless=new',
			'--disable-gpu',
			'--no-sandbox',
			'--disable-background-networking',
			'--disable-default-apps',
			'--disable-extensions',
			'--disable-sync',
			'--disable-translate',
			'--metrics-recording-only',
			'--no-first-run',
			'--mute-audio',
			'--hide-scrollbars',
			'--dump-dom',
			`--virtual-time-budget=${Number.isFinite(budgetMs) ? budgetMs : 5000}`,
			url,
		];

		const ps = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		let finished = false;

		const killTimer = setTimeout(() => {
			if (!finished) {
				ps.kill('SIGKILL');
				reject(new Error('Timeout beim Rendern/DOM-Dump.'));
			}
		}, Number.isFinite(timeoutMs) ? timeoutMs : 15000);

		ps.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
		ps.stderr.on('data', (chunk) => (err += chunk.toString('utf8')));

		ps.on('error', (e) => {
			clearTimeout(killTimer);
			finished = true;
			reject(e);
		});

		ps.on('close', (code) => {
			clearTimeout(killTimer);
			finished = true;
			if (code === 0 && out) {
				resolve(out);
			} else {
				reject(new Error(err || `Chromium beendete sich mit Code ${code}`));
			}
		});
	});
}

/**
 * Extrahiert das Dishy-JSON direkt aus <div class="Json-Text"> (kommt genau 1x vor).
 */
function extractDishyJsonFromHtml(html) {
	// Greife auf den einzigen JSON-Container zu
	const m = html.match(/<div\s+class=["']Json-Text["'][^>]*>([\s\S]*?)<\/div>/i);
	if (!m) {
		return null;
	}

	// Rohtext und einfache HTML-Entity-Dekodierung
	const decode = (s) =>
		s
			.replace(/&nbsp;/g, ' ')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.trim();

	const text = decode(m[1]);

	// Direkt als JSON versuchen
	try {
		return JSON.parse(text);
	} catch (_) {
		// Falls zusätzlicher Text um das JSON steht: letzten JSON-Block herausziehen
		const block = text.match(/\{[\s\S]*\}$/);
		if (!block) {
			return null;
		}
		try {
			return JSON.parse(block[0]);
		} catch {
			return null;
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
		const target = url.searchParams.get('url') || DISHY_ADDRESS;
		const budgetMs = Number(url.searchParams.get('budgetMs')) || 5000;
		const timeoutMs = Number(url.searchParams.get('timeoutMs')) || 15000;

		try {
			const html = await dumpDom(target, { budgetMs, timeoutMs });
			const data = extractDishyJsonFromHtml(html);
			if (!data) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				return res.end(
					JSON.stringify({
									   error: 'Dishy JSON im DOM nicht gefunden',
									   hint: 'Passe ggf. budgetMs/timeoutMs an oder prüfe, ob die Seite erreichbar ist.',
								   }),
				);
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify(data));
		} catch (e) {
			console.error('Fehler beim Headless-Rendering:', e);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			return res.end(
				JSON.stringify({
								   error: 'Headless-Rendering fehlgeschlagen',
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
