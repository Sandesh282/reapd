// Minimal dependency-free HTTP app used as the Phase 1 preview target.
const http = require('node:http');

const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><div id="root"><h1>reapd sample app</h1></div></body></html>');
  })
  .listen(port, '0.0.0.0', () => console.log(`sample-app listening on ${port}`));

