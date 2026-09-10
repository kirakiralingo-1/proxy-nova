const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const compression = require('compression');
const { LRUCache } = require('lru-cache');

const app = express();
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 静的アセットキャッシュ (メモリ) ─────────────────────────
const assetCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 30, // 30分
});

// ─── ユーティリティ ───────────────────────────────────────────
function toAbsolute(base, url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${url}`;
  }
  return new URL(url, base).href;
}

function rewriteHtml(html, baseUrl) {
  // <base> 注入
  html = html.replace(/<head([^>]*)>/i, (m, attrs) =>
    `<head${attrs}><base href="/proxy?url=${encodeURIComponent(baseUrl)}">`
  );

  // 属性 URL 書き換え
  html = html.replace(
    /(\b(?:src|href|action|poster|formaction)\s*=\s*)(["'])([^"']+)\2/gi,
    (match, attr, quote, url) => {
      if (/^(javascript:|data:|#|mailto:|tel:|blob:)/i.test(url)) return match;
      const abs = toAbsolute(baseUrl, url);
      return `${attr}${quote}/proxy?url=${encodeURIComponent(abs)}${quote}`;
    }
  );

  // srcset
  html = html.replace(
    /\bsrcset\s*=\s*["']([^"']+)["']/gi,
    (match, value) => {
      const rewritten = value.split(',').map(part => {
        const trimmed = part.trim();
        const [url, ...rest] = trimmed.split(/\s+/);
        if (!url || /^(data:|blob:)/i.test(url)) return trimmed;
        const abs = toAbsolute(baseUrl, url);
        return `/proxy?url=${encodeURIComponent(abs)}${rest.length ? ' ' + rest.join(' ') : ''}`;
      }).join(', ');
      return `srcset="${rewritten}"`;
    }
  );

  // CSS url()
  html = html.replace(
    /url\(\s*(["']?)(https?:\/\/[^)"']+|\/[^)"']+|[^)"'()]+)\1\s*\)/gi,
    (match, quote, url) => {
      if (/^(data:|blob:)/i.test(url)) return match;
      const abs = toAbsolute(baseUrl, url);
      return `url("/proxy?url=${encodeURIComponent(abs)}")`;
    }
  );

  // @import
  html = html.replace(
    /@import\s+(["'])(https?:\/\/[^"']+|\/[^"']+)\1/gi,
    (match, quote, url) => {
      const abs = toAbsolute(baseUrl, url);
      return `@import "${/proxy?url=${encodeURIComponent(abs)}}"`;
    }
  );

  // インジェクションスクリプト
  const injectScript = `
<script>
(function(){
  // ── frame-buster 対策 ──
  try {
    Object.defineProperty(window, 'top', { get: () => window, configurable: true });
    Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
  } catch(e) {}

  // ── WebSocket インターセプター（Discord の肝）──
  const _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    let wsUrl;
    if (typeof url === 'string') {
      if (/^wss?:\\/\\//i.test(url)) {
        wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
                location.host + '/ws-proxy?url=' + encodeURIComponent(url);
      } else {
        wsUrl = url;
      }
    }
    return new _WS(wsUrl || url, protocols);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

  // ── fetch インターセプター ──
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    let url = typeof input === 'string' ? input : input?.url;
    if (url) {
      if (/^https?:\\/\\//i.test(url)) {
        url = '/proxy?url=' + encodeURIComponent(url);
      } else if (!url.startsWith('/') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('http') && !url.startsWith('wss')) {
        try { url = '/proxy?url=' + encodeURIComponent(new URL(url, location.origin).href); } catch(e){}
      }
    }
    if (typeof input === 'string') input = url;
    else if (input instanceof Request) { try { input = new Request(url, input); } catch(e){ input = url; } }
    return _fetch.call(this, input, init);
  };

  // ── XMLHttpRequest インターセプター ──
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (url && /^https?:\\/\\//i.test(url)) {
      url = '/proxy?url=' + encodeURIComponent(url);
    } else if (url && !url.startsWith('/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      try { url = '/proxy?url=' + encodeURIComponent(new URL(url, location.origin).href); } catch(e){}
    }
    return _open.call(this, method, url, ...rest);
  };

  // ── window.open インターセプター ──
  const _openWin = window.open;
  window.open = function(url, ...rest) {
    if (url && /^https?:\\/\\//i.test(url)) {
      url = '/proxy?url=' + encodeURIComponent(url);
    }
    return _openWin.call(this, url, ...rest);
  };

  // ── Service Worker 登録を無効化（プロキシでは動かないため）──
  const _regSW = navigator.serviceWorker?.register;
  if (_regSW) {
    navigator.serviceWorker.register = function() {
      return Promise.resolve({ update: () => {} });
    };
  }
})();
</script>`;

  html = html.replace(/<\/body>/i, `${injectScript}\n</body>`);
  if (!html.includes('</body>')) html += injectScript;
  return html;
}

// ─── HTTP プロキシ（全メソッド対応）──────────────────────────
const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

httpMethods.forEach(method => {
  app[method]('/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing url');

    let targetUrl;
    try { targetUrl = new URL(url); } catch { return res.status(400).send('Invalid URL'); }
    if (!/^https?:$/.test(targetUrl.protocol)) return res.status(400).send('Only http/https');

    // キャッシュチェック（GETのみ）
    const cacheKey = targetUrl.href;
    if (method === 'get' && !req.headers['x-no-cache']) {
      const cached = assetCache.get(cacheKey);
      if (cached) {
        res.set(cached.headers);
        res.set('X-Cache', 'HIT');
        return res.send(cached.body);
      }
    }

    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
      };

      // 元リクエストのヘッダを転送（Content-Type, Authorization 等）
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
      if (req.headers['cookie']) headers['Cookie'] = req.headers['cookie'];
      if (req.headers['x-discord-locale']) headers['X-Discord-Locale'] = req.headers['x-discord-locale'];

      const body = ['post', 'put', 'patch'].includes(method) ? req.body : undefined;

      const response = await fetch(targetUrl.href, {
        method: method.toUpperCase(),
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });

      const ct = response.headers.get('content-type') || '';
      const buf = Buffer.from(await response.arrayBuffer());

      // セキュリティヘッダを剥がす
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.removeHeader('Content-Security-Policy-Report-Only');
      res.removeHeader('X-Content-Type-Options');
      res.removeHeader('Cross-Origin-Resource-Policy');

      // CORS 許可
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
      res.set('Access-Control-Allow-Headers', '*');

      if (ct.includes('text/html')) {
        let html = buf.toString('utf-8');
        html = rewriteHtml(html, targetUrl.href);
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } else if (ct.startsWith('text/css')) {
        let css = buf.toString('utf-8');
        css = css.replace(
          /url\(\s*(["']?)(https?:\/\/[^)"']+|\/[^)"']+|[^)"'()]+)\1\s*\)/gi,
          (match, quote, url) => {
            if (/^(data:|blob:)/i.test(url)) return match;
            const abs = toAbsolute(targetUrl.href, url);
            return `url("/proxy?url=${encodeURIComponent(abs)}")`;
          }
        );
        res.set('Content-Type', 'text/css; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(css);
      } else {
        // 静的アセットをキャッシュ
        if (method === 'get' && (ct.startsWith('image/') || ct.startsWith('font/') || ct.includes('javascript') || ct.includes('json'))) {
          assetCache.set(cacheKey, {
            body: buf,
            headers: { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }
          });
        }
        res.set('Content-Type', ct || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buf);
      }
    } catch (err) {
      res.status(502).send(`Proxy error: ${err.message}`);
    }
  });
});

// ─── WebSocket プロキシ（Discord の肝）────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws-proxy') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      // ターゲット WebSocket へ接続
      const target = new WebSocket(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Origin': new URL(targetUrl).origin,
        },
      });

      target.on('open', () => {
        // クライアント ↔ ターゲット 双方向リレー
        clientWs.on('message', (data, isBinary) => {
          if (target.readyState === WebSocket.OPEN) {
            target.send(data, { binary: isBinary });
          }
        });
        clientWs.on('close', (code, reason) => {
          target.close(code, reason);
        });
        clientWs.on('error', () => {
          target.close();
        });
      });

      target.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      target.on('close', (code, reason) => {
        clientWs.close(code, reason);
      });

      target.on('error', (err) => {
        clientWs.close(1011, 'Target WS error');
      });
    });
  } else {
    socket.destroy();
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Proxy (HTTP+WS) running on port ${port}`));   
