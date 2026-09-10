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
// メインプロキシルート
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.all("/p/*", (req, res) => {
  let targetUrl = req.params[0];
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;

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

      const respHeaders = { ...proxyRes.headers };
      delete respHeaders["x-frame-options"];
      delete respHeaders["content-security-policy"];
      delete respHeaders["content-security-policy-report-only"];
      delete respHeaders["cross-origin-embedder-policy"];
      delete respHeaders["cross-origin-opener-policy"];
      delete respHeaders["cross-origin-resource-policy"];
      delete respHeaders["transfer-encoding"];
      delete respHeaders["set-cookie"];

      res.writeHead(proxyRes.statusCode, respHeaders);

      if (ct.includes("text/html")) {
        let data = "";
        proxyRes.on("data", (c) => (data += c));
        proxyRes.on("end", () => {
          let html = rewriteHTML(data, targetUrl);
          html = injectInterceptor(html, targetUrl);
          res.end(html);
        });
      } else if (ct.includes("text/css")) {
        // ★ 重要: CSSファイル自身のURLを基準にurl()を書き換え
        let data = "";
        proxyRes.on("data", (c) => (data += c));
        proxyRes.on("end", () => {
          res.end(rewriteCSS(data, targetUrl));
        });
      } else {
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
  if (!req.url.startsWith("/wsp/")) { socket.destroy(); return; }

  const targetWs = req.url.slice(5);
  const wParsed = new URL(targetWs);

  try {
    const upstream = new WebSocket(wParsed.href, {
      headers: { host: wParsed.hostname },
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
  } catch { socket.destroy(); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// URL変換ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function toProxyUrl(url, baseUrl) {
  if (!url || typeof url !== "string") return url;
  if (/^(data:|blob:|javascript:|#|about:|mailto:|tel:)/.test(url)) return url;
  if (url.startsWith("/p/")) return url;
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const abs = new URL(url, baseUrl).href;
    return "/p/" + abs;
  } catch { return url; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTML書き換え
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function rewriteHTML(html, pageUrl) {
  return html
    // src / href / action / data-* 属性
    .replace(
      /(src|href|action|data-src|data-href|data-lazy-src|poster)\s*=\s*(["'])([^"']*)\2/gi,
      (m, attr, quote, url) => `${attr}=${quote}${toProxyUrl(url, pageUrl)}${quote}`
    )
    // CSS url() within <style> tags
    .replace(
      /<style[^>]*>([\s\S]*?)<\/style>/gi,
      (m, css) => `<style>${rewriteCSS(css, pageUrl)}</style>`
    )
    // meta refresh
    .replace(
      /content\s*=\s*["']([^"']*url\s*=\s*[^"']*)["']/gi,
      (m, content) => {
        const rw = content.replace(/url\s*=\s*([^&"']+)/i, (mm, u) => `url=${toProxyUrl(u, pageUrl)}`);
        return `content="${rw}"`;
      }
    )
    // <base> 除去
    .replace(/<base\s[^>]*>/gi, "");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSS書き換え（★CSSファイル自身のURLを基準）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function rewriteCSS(css, cssFileUrl) {
  return css
    .replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, url) => {
      if (/^(data:|#|blob:)/.test(url)) return m;
      return `url("${toProxyUrl(url, cssFileUrl)}")`;
    })
    .replace(/@import\s+["']([^"']+)["']/gi, (m, url) => {
      return `@import "${toProxyUrl(url, cssFileUrl)}"`;
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JSインジェクション（fetch/XHR/WS/動的style追跡）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function injectInterceptor(html, originalUrl) {
  const script = `<script>
(function(){
  var P = "/p/";
  var ORIGIN = ${JSON.stringify(new URL(originalUrl).origin)};

  function rw(url) {
    if (!url || typeof url !== "string") return url;
    if (/^(data:|blob:|javascript:|#|about:|mailto:|tel:)/.test(url)) return url;
    if (url.startsWith(P)) return url;
    if (url.startsWith("//")) url = "https:" + url;
    try {
      var u = new URL(url, window.location.href);
      if (u.origin === window.location.origin && !u.pathname.startsWith(P)) return url;
      return P + u.href;
    } catch(e) { return url; }
  }

  // ── fetch ──
  var _f = window.fetch;
  window.fetch = function(i, o) {
    if (typeof i === "string") i = rw(i);
    else if (i instanceof Request) i = new Request(rw(i.url), i);
    return _f.call(this, i, o);
  };

  // ── XHR ──
  var _o = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u) {
    return _o.apply(this, [m, rw(u)].concat(Array.prototype.slice.call(arguments, 2)));
  };

  // ── WebSocket ──
  var _W = window.WebSocket;
  window.WebSocket = function(u, p) {
    if (u && (u.startsWith("ws://") || u.startsWith("wss://"))) {
      var h = u.replace(/^ws/, "http");
      u = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wsp/" + h;
    }
    return new _W(u, p);
  };
  window.WebSocket.prototype = _W.prototype;
  window.WebSocket.CONNECTING=0; window.WebSocket.OPEN=1;
  window.WebSocket.CLOSING=2; window.WebSocket.CLOSED=3;

  // ── window.open ──
  var _w = window.open;
  window.open = function(u) { if (u && typeof u === "string") u = rw(u); return _w.call(this, u); };

  // ── <a> クリック ──
  document.addEventListener("click", function(e) {
    var a = e.target.closest("a");
    if (!a) return;
    var h = a.getAttribute("href");
    if (!h || h.startsWith("javascript:") || h.startsWith("#")) return;
    if (h.startsWith(P)) return;
    e.preventDefault();
    location.href = rw(h);
  }, true);

  // ── ★ 動的 <style> / <link> / <img> / <video> 追跡 ──
  function fixStyleEl(el) {
    if (el.tagName === "STYLE" && el.textContent) {
      el.textContent = el.textContent.replace(
        /url\\(\\s*["']?([^"')]+)["']?\\s*\\)/gi,
        function(m, u) {
          if (/^(data:|#|blob:)/.test(u)) return m;
          return 'url("' + rw(u) + '")';
        }
      ).replace(
        /@import\\s+["']([^"']+)["']/gi,
        function(m, u) { return '@import "' + rw(u) + '"'; }
      );
    }
  }

  function fixEl(el) {
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName;
    if (tag === "STYLE") { fixStyleEl(el); return; }
    if (tag === "LINK" && (el.rel === "stylesheet" || el.rel === "preload" || el.rel === "icon")) {
      if (el.href) el.href = rw(el.href);
      return;
    }
    if (tag === "IMG" || tag === "VIDEO" || tag === "SOURCE" || tag === "AUDIO" || tag === "INPUT") {
      if (el.src) el.src = rw(el.src);
      if (el.getAttribute("srcset")) {
        el.srcset = el.srcset.split(",").map(function(s) {
          var parts = s.trim().split(/\\s+/);
          parts[0] = rw(parts[0]);
          return parts.join(" ");
        }).join(", ");
      }
      return;
    }
    if (tag === "SCRIPT" && el.src) { el.src = rw(el.src); return; }
  }

  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) {
          fixEl(m.addedNodes[j]);
          // 子要素も走査
          if (m.addedNodes[j].querySelectorAll) {
            var children = m.addedNodes[j].querySelectorAll("style,link,img,video,source,audio,script");
            for (var k = 0; k < children.length; k++) fixEl(children[k]);
          }
        }
      }
      if (m.type === "attributes" && m.attributeName === "src") {
        fixEl(m.target);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src","href"] });

  // 既存の要素も修正
  var existing = document.querySelectorAll("style,link[rel],img,video,source,script[src]");
  for (var i = 0; i < existing.length; i++) fixEl(existing[i]);
})();
</script>`;

  if (html.includes("</head>")) {
    return html.replace("</head>", script + "\n</head>");
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, (m) => m + script);
  }
  return script + html;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ルート
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on :${PORT}`);
});   
