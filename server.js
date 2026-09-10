const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── 注入スクリプト（全 HTML ページに挿入） ───
function buildInjectedScript(proxyBase) {
  const wsBase = (location_protocol) =>
    location_protocol === 'https:' ? 'wss://' : 'ws://';

  return `
<script>
(function() {
  var PB = '${proxyBase}';
  var WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws-proxy/';

  function pUrl(url) {
    if (!url) return url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) return url;
    try {
      var u = new URL(url, location.href);
      if (u.origin === location.origin) return url;
      return PB + u.toString();
    } catch(e) { return url; }
  }

  // ── fetch 拦截 ──
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = pUrl(input);
    else if (input instanceof Request) input = new Request(pUrl(input.url), input);
    return _fetch.call(this, input, init);
  };

  // ── XMLHttpRequest 拦截 ──
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') url = pUrl(url);
    var args = [method, url].concat(Array.prototype.slice.call(arguments, 2));
    return _open.apply(this, args);
  };

  // ── WebSocket 拦截 ──
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    try {
      var u = new URL(url, location.href);
      if (u.origin !== location.origin) {
        url = WS_BASE + u.toString();
      }
    } catch(e) {}
    return new _WS(url, protocols);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;

  // ── window.open 拦截 ──
  var _open = window.open;
  window.open = function(url) {
    if (url) url = pUrl(url);
    return _open.apply(this, arguments);
  };

  // ── target="_blank" リンク ──
  document.addEventListener('click', function(e) {
    var a = e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      window.open(pUrl(a.href), '_blank');
    }
  }, true);

  // ── location 変更（SPA ナビゲーション）──
  // history.pushState / replaceState を拦截
  var _push = history.pushState;
  history.pushState = function() {
    if (arguments[2]) arguments[2] = pUrl(arguments[2]);
    return _push.apply(this, arguments);
  };
  var _replace = history.replaceState;
  history.replaceState = function() {
    if (arguments[2]) arguments[2] = pUrl(arguments[2]);
    return _replace.apply(this, arguments);
  };

  // ── new Image() ──
  var _Image = window.Image;
  window.Image = function(w) {
    var img = new _Image(w);
    var _src;
    Object.defineProperty(img, 'src', {
      get: function() { return _src; },
      set: function(v) { _src = pUrl(v); img.setAttribute('src', _src); }
    });
    return img;
  };
  window.Image.prototype = _Image.prototype;

  // ── sendBeacon ──
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      return _beacon(pUrl(url), data);
    };
  }
})();
</script>`;
}

// ─── URL 書き換えヘルパー ───
function makeRewriter(targetUrl, proxyBase) {
  return function rewriteUrl(originalUrl) {
    if (!originalUrl) return originalUrl;
    if (originalUrl.startsWith('data:') || originalUrl.startsWith('blob:') ||
        originalUrl.startsWith('#') || originalUrl.startsWith('javascript:') ||
        originalUrl.startsWith('mailto:') || originalUrl.startsWith('tel:')) {
      return originalUrl;
    }
    try {
      const abs = new URL(originalUrl, targetUrl);
      return `${proxyBase}/${abs.toString()}`;
    } catch {
      return originalUrl;
    }
  };
}

// ─── HTML 書き換え ───
function rewriteHtml(html, targetUrl, proxyBase) {
  const $ = cheerio.load(html);
  const rw = makeRewriter(targetUrl, proxyBase);

  // 標準属性
  $('a[href]').each((_, el) => $(el).attr('href', rw($(el).attr('href'))));
  $('img[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('img[srcset]').each((_, el) => {
    $(el).attr('srcset', $(el).attr('srcset').split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      parts[0] = rw(parts[0]);
      return parts.join(' ');
    }).join(', '));
  });
  $('source[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('source[srcset]').each((_, el) => {
    $(el).attr('srcset', $(el).attr('srcset').split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      parts[0] = rw(parts[0]);
      return parts.join(' ');
    }).join(', '));
  });
  $('script[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('link[href]').each((_, el) => $(el).attr('href', rw($(el).attr('href'))));
  $('iframe[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('video[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('audio[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('embed[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('object[data]').each((_, el) => $(el).attr('data', rw($(el).attr('data'))));
  $('form[action]').each((_, el) => $(el).attr('action', rw($(el).attr('action'))));
  $('input[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('button formaction').each((_, el) => $(el).attr('formaction', rw($(el).attr('formaction'))));

  // meta refresh
  $('meta[http-equiv="refresh"]').each((_, el) => {
    let content = $(el).attr('content');
    content = content.replace(/url=([^;\s]+)/i, (m, url) => `url=${rw(url.trim())}`);
    $(el).attr('content', content);
  });

  // インライン style 属性の url()
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    const newStyle = style.replace(/url\((['"]?)([^)'""]+)\1\)/g, (m, q, url) => {
      return `url(${rw(url.trim())})`;
    });
    $(el).attr('style', newStyle);
  });

  // <style> ブロック内の url() と @import
  $('style').each((_, el) => {
    let css = $(el).html();
    css = css.replace(/url\((['"]?)([^)'""]+)\1\)/g, (m, q, url) => {
      return `url(${rw(url.trim())})`;
    });
    css = css.replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, url) => {
      return `@import ${q}${rw(url.trim())}${q}`;
    });
    $(el).html(css);
  });

  // 注入スクリプトを <head> の先頭に挿入
  const injected = buildInjectedScript(proxyBase);
  if ($('#head').length) {
    $('#head').prepend(injected);
  } else {
    $('html').prepend(injected);
  }

  return $.html();
}

// ─── プロキシルート ───
app.all('/proxy/*', async (req, res) => {
  const targetUrl = req.params[0];

  try {
    const url = new URL(targetUrl);
    const method = req.method;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',
    };

    // 元のヘッダから有用なものだけコピー
    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
    if (req.headers['content-type'] && method !== 'GET') headers['Content-Type'] = req.headers['content-type'];

    const resp = await axios({
      method,
      url: targetUrl,
      headers,
      data: method !== 'GET' ? req.body : undefined,
      maxRedirects: 5,
      timeout: 30000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });

    const contentType = resp.headers['content-type'] || '';
    const proxyBase = `https://${req.headers.host}/proxy`;

    if (contentType.includes('text/html')) {
      const html = Buffer.from(resp.data).toString('utf-8');
      const rewritten = rewriteHtml(html, targetUrl, proxyBase);

      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'ALLOWALL',
        'Content-Security-Policy': "frame-ancestors *; object-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' *; style-src 'unsafe-inline' *; img-src * data: blob:; connect-src * wss: ws:; font-src * data:",
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.status(resp.status).send(rewritten);
    } else {
      const safeHeaders = { ...resp.headers };
      delete safeHeaders['x-frame-options'];
      delete safeHeaders['content-security-policy'];
      delete safeHeaders['content-security-policy-report-only'];
      delete safeHeaders['cross-origin-opener-policy'];
      delete safeHeaders['cross-origin-embedder-policy'];
      delete safeHeaders['cross-origin-resource-policy'];
      delete safeHeaders['transfer-encoding'];
      safeHeaders['Access-Control-Allow-Origin'] = '*';
      safeHeaders['Cache-Control'] = 'no-store';

      res.set(safeHeaders);
      res.status(resp.status).send(Buffer.from(resp.data));
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).type('text/plain').send(`Proxy Error: ${err.message}`);
  }
});

// ─── WebSocket プロキシ ───
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws-proxy/')) {
    socket.destroy();
    return;
  }

  const targetUrl = req.url.replace('/ws-proxy/', '');
  console.log('[WS] Proxying:', targetUrl);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    let targetWs;
    try {
      targetWs = new WebSocket(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Origin': new URL(targetUrl).origin,
        },
        protocol: req.headers['sec-websocket-protocol'] || undefined,
        followRedirects: false,
        handshakeTimeout: 15000,
      });
    } catch (e) {
      clientWs.close(1002, 'Invalid WS URL');
      return;
    }

    targetWs.on('open', () => {
      console.log('[WS] Connected to target');
      clientWs.on('message', (data, isBinary) => {
        if (targetWs.readyState === WebSocket.OPEN) targetWs.send(data, { binary: isBinary });
      });
      targetWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
      });
      clientWs.on('close', () => targetWs.close());
      targetWs.on('close', () => clientWs.close());
      clientWs.on('error', () => { try { targetWs.close(); } catch(e){} });
      targetWs.on('error', () => { try { clientWs.close(); } catch(e){} });
    });

    targetWs.on('error', (err) => {
      console.error('[WS] Target error:', err.message);
      try { clientWs.close(1002, 'Proxy WS error'); } catch(e){}
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Proxy v2 running on port ${PORT}`);
});   
