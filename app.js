const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── ユーティリティ ───────────────────────────────────────────
function toAbsolute(base, url) {
  if (!url) return url;
  if (/^(https?:)?\/\//i.test(url)) return url.startsWith('http') ? url : 'https:' + url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${url}`;
  }
  return new URL(url, base).href;
}

function rewriteHtml(html, baseUrl) {
  // 1) <base> タグを注入（相対URL解決の基準）
  html = html.replace(/<head([^>]*)>/i, (m, attrs) =>
    `<head${attrs}><base href="/proxy?url=${encodeURIComponent(baseUrl)}">`
  );

  // 2) src / href / action / srcset / poster / formaction 属性を書き換え
  html = html.replace(
    /(\b(?:src|href|action|poster|formaction)\s*=\s*)(["'])([^"']+)\2/gi,
    (match, attr, quote, url) => {
      if (/^(javascript:|data:|#|mailto:|tel:)/i.test(url)) return match;
      const abs = toAbsolute(baseUrl, url);
      return `${attr}${quote}/proxy?url=${encodeURIComponent(abs)}${quote}`;
    }
  );

  // 3) srcset 属性（カンマ区切りの複数URL）
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

  // 4) CSS url(...) 内のURL
  html = html.replace(
    /url\(\s*(["']?)(https?:\/\/[^)"']+|\/[^)"']+|[^)"'()]+)\1\s*\)/gi,
    (match, quote, url) => {
      if (/^(data:|blob:)/i.test(url)) return match;
      const abs = toAbsolute(baseUrl, url);
      return `url("${/proxy?url=${encodeURIComponent(abs)}")`;
    }
  );

  // 5) @import
  html = html.replace(
    /@import\s+(["'])(https?:\/\/[^"']+|\/[^"']+)\1/gi,
    (match, quote, url) => {
      const abs = toAbsolute(baseUrl, url);
      return `@import "${/proxy?url=${encodeURIComponent(abs)}}"`;
    }
  );

  // 6) フレームバスター対策 + fetch/XHR インターセプターを注入
  const injectScript = `
<script>
(function(){
  // frame-buster 対策
  try {
    Object.defineProperty(window, 'top', { get: () => window, configurable: true });
    Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
  } catch(e) {}

  // fetch インターセプター
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    let url = typeof input === 'string' ? input : input?.url;
    if (url && /^https?:\\/\\//i.test(url)) {
      url = '/proxy?url=' + encodeURIComponent(url);
      input = typeof input === 'string' ? url : new Request(url, input);
    } else if (url && !url.startsWith('/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      const abs = new URL(url, window.location.origin).href;
      url = '/proxy?url=' + encodeURIComponent(abs);
      input = typeof input === 'string' ? url : new Request(url, input);
    }
    return _fetch.call(this, input, init);
  };

  // XMLHttpRequest インターセプター
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (url && /^https?:\\/\\//i.test(url)) {
      url = '/proxy?url=' + encodeURIComponent(url);
    } else if (url && !url.startsWith('/') && !url.startsWith('data:')) {
      try {
        const abs = new URL(url, window.location.origin).href;
        url = '/proxy?url=' + encodeURIComponent(abs);
      } catch(e) {}
    }
    return _open.call(this, method, url, ...rest);
  };

  // window.open インターセプター
  const _open = window.open;
  window.open = function(url, ...rest) {
    if (url && /^https?:\\/\\//i.test(url)) {
      url = '/proxy?url=' + encodeURIComponent(url);
    }
    return _open.call(this, url, ...rest);
  };
})();
</script>`;

  html = html.replace(/<\/body>/i, `${injectScript}\n</body>`);
  if (!html.includes('</body>')) html += injectScript;

  return html;
}

// ─── プロキシエンドポイント ───────────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url parameter');

  let targetUrl;
  try { targetUrl = new URL(url); } catch { return res.status(400).send('Invalid URL'); }
  if (!/^https?:$/.test(targetUrl.protocol)) return res.status(400).send('Only http/https');

  try {
    const response = await fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
      },
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

    if (ct.includes('text/html')) {
      let html = buf.toString('utf-8');
      html = rewriteHtml(html, targetUrl.href);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } else if (ct.startsWith('image/') || ct.startsWith('font/') || ct.startsWith('audio/') || ct.startsWith('video/')) {
      res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
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
      res.send(css);
    } else if (ct.includes('javascript')) {
      res.set('Content-Type', 'application/javascript; charset=utf-8');
      res.send(buf);
    } else {
      res.set('Content-Type', ct || 'application/octet-stream');
      res.send(buf);
    }
  } catch (err) {
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy running on port ${port}`));   
