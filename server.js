const express = require("express");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// メインプロキシルート（iframeなし・トップレベル返却）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.all("/p/*", (req, res) => {
  let targetUrl = req.params[0];
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;

  // リクエストボディ収集
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "*/*",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
      host: parsed.hostname,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    };

    if (body.length) {
      headers["content-length"] = body.length;
      if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    }

    const options = {
      hostname: parsed.hostname,
      port: isHttps ? 443 : 80,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers,
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      const ct = (proxyRes.headers["content-type"] || "").toLowerCase();

      // セキュリティヘッダを除去
      const respHeaders = { ...proxyRes.headers };
      delete respHeaders["x-frame-options"];
      delete respHeaders["content-security-policy"];
      delete respHeaders["content-security-policy-report-only"];
      delete respHeaders["cross-origin-embedder-policy"];
      delete respHeaders["cross-origin-opener-policy"];
      delete respHeaders["cross-origin-resource-policy"];
      delete respHeaders["transfer-encoding"];
      delete respHeaders["set-cookie"]; // cookie問題回避

      res.writeHead(proxyRes.statusCode, respHeaders);

      if (ct.includes("text/html")) {
        // HTML → 書き換え + JS注入
        let data = "";
        proxyRes.on("data", (c) => (data += c));
        proxyRes.on("end", () => {
          let html = rewriteHTML(data, targetUrl);
          html = injectInterceptor(html, targetUrl);
          res.end(html);
        });
      } else if (ct.includes("text/css")) {
        // CSS → url()書き換え
        let data = "";
        proxyRes.on("data", (c) => (data += c));
        proxyRes.on("end", () => {
          res.end(rewriteCSS(data, targetUrl));
        });
      } else {
        // 画像・JSON・その他 → そのままpipe
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.status(502).json({ error: err.message });
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WebSocketプロキシ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/wsp/")) {
    socket.destroy();
    return;
  }

  const targetWs = req.url.slice(5); // "/wsp/" を除去
  const wParsed = new URL(targetWs);

  try {
    const upstream = new WebSocket(wParsed.href, {
      headers: { host: wParsed.hostname, "user-agent": headers["user-agent"] },
      rejectUnauthorized: false,
    });

    upstream.on("open", () => {
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      if (head.length) socket.write(head);

      upstream.on("message", (msg) => socket.write(msg));
      socket.on("data", (data) => upstream.send(data));
      upstream.on("close", () => socket.end());
      socket.on("close", () => upstream.close());
      upstream.on("error", () => socket.end());
      socket.on("error", () => upstream.close());
    });

    upstream.on("error", () => socket.destroy());
  } catch {
    socket.destroy();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTML書き換え関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function toProxyUrl(url, originalUrl) {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("javascript:") || url.startsWith("#") || url.startsWith("about:")) return url;
  if (url.startsWith("/p/")) return url;
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const abs = new URL(url, originalUrl).href;
    return "/p/" + abs;
  } catch {
    return url;
  }
}

function rewriteHTML(html, originalUrl) {
  return html
    // src, href, action 属性
    .replace(
      /(src|href|action|data-src|data-href|data-lazy-src)\s*=\s*["']([^"']*)["']/gi,
      (m, attr, url) => `${attr}="${toProxyUrl(url, originalUrl)}"`
    )
    // CSS url()
    .replace(
      /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
      (m, url) => `url(${toProxyUrl(url, originalUrl)})`
    )
    // @import
    .replace(
      /@import\s+["']([^"']+)["']/gi,
      (m, url) => `@import "${toProxyUrl(url, originalUrl)}"`
    )
    // meta refresh
    .replace(
      /content\s*=\s*["']([^"']*url\s*=\s*[^"']*)["']/gi,
      (m, content) => {
        const rewritten = content.replace(/url\s*=\s*([^&"']+)/i, (mm, u) => `url=${toProxyUrl(u, originalUrl)}`);
        return `content="${rewritten}"`;
      }
    )
    // <base> タグ除去（競合するから）
    .replace(/<base\s[^>]*>/gi, "");
}

function rewriteCSS(css, originalUrl) {
  return css
    .replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, url) => `url(${toProxyUrl(url, originalUrl)})`)
    .replace(/@import\s+["']([^"']+)["']/gi, (m, url) => `@import "${toProxyUrl(url, originalUrl)}"`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JSインジェクション（fetch/XHR/WS/window.open上書き）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function injectInterceptor(html, originalUrl) {
  const script = `<script>
(function(){
  var ORIGIN = ${JSON.stringify(new URL(originalUrl).origin)};
  var PROXY_PREFIX = "/p/";

  function rw(url) {
    if (!url || typeof url !== "string") return url;
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:")) return url;
    if (url.startsWith(PROXY_PREFIX)) return url;
    if (url.startsWith("//")) url = "https:" + url;
    try {
      var u = new URL(url, window.location.href);
      if (u.origin === window.location.origin) return url;
      return PROXY_PREFIX + u.href;
    } catch(e) { return url; }
  }

  // fetch上書き
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === "string") input = rw(input);
    else if (input instanceof Request) input = new Request(rw(input.url), input);
    return _fetch.call(this, input, init);
  };

  // XHR上書き
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    url = rw(url);
    return _open.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };

  // WebSocket上書き
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      var wsUrl = url.replace(/^ws/, "http");
      url = (window.location.protocol === "https:" ? "wss://" : "ws://") +
            window.location.host + "/wsp/" + wsUrl;
    }
    return new _WS(url, protocols);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

  // window.open上書き
  var _open = window.open;
  window.open = function(url) {
    if (url && typeof url === "string") url = rw(url);
    return _open.call(this, url);
  };

  // location.href 代入（ナビゲーション）
  var _nav = window.location;
  // locationはプロパティなので直接上書き不可 → beforeunloadで補完
  document.addEventListener("click", function(e) {
    var a = e.target.closest("a");
    if (a && a.href && a.href.indexOf(window.location.origin) === 0) return;
    if (a && a.href && !a.href.startsWith("javascript:") && !a.href.startsWith("#")) {
      e.preventDefault();
      window.location.href = rw(a.href);
    }
  }, true);
})();
</script>`;

  if (html.includes("</head>")) {
    return html.replace("</head>", script + "\n</head>");
  }
  if (html.includes("<body")) {
    return html.replace(/<body([^>]*)>/i, (m) => m + script);
  }
  return script + html;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ルート（ランディングページ）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Full proxy running on :${PORT}`);
});   
