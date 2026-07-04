// Local dev server — serves /public and routes /api/* to the shared handler.
// In production the exact same lib/api + lib/store run inside a Vercel function.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi } = require('./lib/api');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, store);
  }

  if (req.method === 'GET') {
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^([.][.][/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  const L = require('./lib/logic');
  console.log(`The Rush running on port ${PORT}  [store: ${store.driver}]`);
  console.log(`  admin (leaderboard): ${L.ADMIN_EMAIL}`);
  console.log(`  one account per IP:  ${L.ONE_ACCOUNT_PER_IP ? 'on' : 'off'}`);
  console.log(`  trust proxy (XFF):   ${L.TRUST_PROXY ? 'on' : 'off'}`);
});
