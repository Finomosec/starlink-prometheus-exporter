const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  // Nur GET erlauben
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Server ist aktiv.');
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      })
    );
  }

  // 404 für alle anderen GET-Routen
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`Server lauscht auf http://localhost:${PORT}`);
});
