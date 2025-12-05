const http = require('http');
const { URL } = require('url');
const { initBrowser, extractJsonFromPage } = require('./browser');
const { jsonToPrometheus } = require('./helpers');

const PORT = process.env.PORT || 8055;
const DISHY_ADDRESS = process.env.DISHY_ADDRESS || 'http://192.168.100.1';
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
const METRICS_PREFIX = process.env.METRICS_PREFIX || 'starlink_';

let browserReady = false;

// Browser beim Start initialisieren
(async () => {
  try {
    console.log('Initialisiere Browser...');
    await initBrowser({ host: CDP_HOST, port: CDP_PORT, dishyUrl: DISHY_ADDRESS });
    browserReady = true;
    console.log('Browser bereit.');
  } catch (err) {
    console.error('Browser-Initialisierung fehlgeschlagen:', err);
    process.exit(1);
  }
})();

const server = http.createServer(async (req, res) => {
	if (req.method !== 'GET') {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
	}

	const url = new URL(req.url, `http://${req.headers.host}`);

	if (url.pathname === '/') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		return res.end('<html><body><a href="/metrics">/metrics</a><br/><a href="/health">/health</a></body></html>');
	}

	if (url.pathname === '/metrics') {
		if (!browserReady) {
			res.writeHead(503, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: 'Browser noch nicht bereit' }));
		}

		try {
			const startTimestamp = Date.now();
			const data = await extractJsonFromPage();

			const endTimestamp = Date.now();
			data.exporter_request_ms = endTimestamp - startTimestamp;

			let body;
			try {
				body = jsonToPrometheus(data, METRICS_PREFIX);
			} catch (convErr) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({
					error: 'Metric conversion failed',
					message: convErr && convErr.message ? convErr.message : String(convErr)
				}));
			}

			res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
			return res.end(body);
		} catch (e) {
			console.error('Scrape-Error:', e && e.message ? e.message : e);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			return res.end(
				JSON.stringify({
					error: 'Scrape fehlgeschlagen',
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

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
	console.log(`Server lauscht auf http://localhost:${PORT}`);
});
