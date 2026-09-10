const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

// 全リクエストをリバースプロキシ
app.use('/p', (req, res, next) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  const parsed = new URL(target);
  const path = req.path.slice(2); // /p を除去

  const proxy = createProxyMiddleware({
    target: `${parsed.protocol}//${parsed.host}`,
    changeOrigin: true,
    secure: false,
    pathRewrite: { '^/p': parsed.pathname || '/' },
    selfHandleResponse: true,
  });

  proxy(req, res, (err) => {
    if (err) return res.status(502).send('Proxy error: ' + err.message);
  });

  // レスポンスヘッダーを修正（CORS / X-Frame-Options 削除）
  res.on('finish', () => {
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');
  });

  // CORS 許可
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');

  next();
});

// WebSocket プロキシ（Discord 用）
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { url, data: wsData } = msg;
      const parsed = new URL(url);

      const client = new WebSocket(
        parsed.protocol === 'https:' ? 'wss://' : 'ws://',
        parsed.host + parsed.pathname
      );

      client.on('open', () => {
        ws.send(JSON.stringify({ type: 'connected' }));
        if (wsData) client.send(wsData);
      });
      client.on('message', (d) => ws.send(JSON.stringify({ type: 'data', data: d.toString() })));
      client.on('close', (code, reason) => ws.send(JSON.stringify({ type: 'close', code, reason: reason.toString() })));
      client.on('error', (e) => ws.send(JSON.stringify({ type: 'error', message: e.message })));

      ws.on('message', (d) => client.send(d.toString()));
      ws.on('close', () => client.close());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy server running on port ${PORT}`);
});   
