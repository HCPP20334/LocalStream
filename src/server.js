const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

const HTTP_PORT = 3000;   
const HTTPS_PORT = 3443; 
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function handler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/view.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

async function getCert() {
  const dir = path.join(__dirname, 'cert');
  const keyF = path.join(dir, 'key.pem');
  const certF = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyF) && fs.existsSync(certF))
    return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) };

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIPs().map(ip => ({ type: 7, ip }))
  ];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }]
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyF, pems.private);
  fs.writeFileSync(certF, pems.cert);
  return { key: pems.private, cert: pems.cert };
}
const wss = new WebSocketServer({ noServer: true });
let streamer = null;
const viewers = new Map();
let nextId = 1;
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');
  ws.id = String(nextId++);

  if (role === 'streamer') {
    if (streamer && streamer !== ws) streamer.close();
    streamer = ws;
    for (const v of viewers.values()) send(v, { type: 'streamer-ready' });
  } else {
    viewers.set(ws.id, ws);
    if (streamer) send(streamer, { type: 'join', from: ws.id });
  }

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (role === 'streamer') {
      const v = viewers.get(m.to);
      if (v) send(v, m);
    } else if (streamer) {
      send(streamer, { ...m, from: ws.id });
    }
  });

  ws.on('close', () => {
    if (role === 'streamer') {
      if (streamer === ws) {
        streamer = null;
        for (const v of viewers.values()) send(v, { type: 'streamer-left' });
      }
    } else {
      viewers.delete(ws.id);
      if (streamer) send(streamer, { type: 'leave', from: ws.id });
    }
  });
});

function attachWs(server) {
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws')) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    else socket.destroy();
  });
}

(async () => {
  const httpServer = http.createServer(handler);
  attachWs(httpServer);
  httpServer.listen(HTTP_PORT);

  const httpsServer = https.createServer(await getCert(), handler);
  attachWs(httpsServer);
  httpsServer.listen(HTTPS_PORT);

  console.log('\nserver runned');
  console.log(`view http://localhost:${HTTP_PORT}/view.html`);
  for (const ip of lanIPs())
    console.log(`opeb ip: https://${ip}:${HTTPS_PORT}/stream.html`);
})();
