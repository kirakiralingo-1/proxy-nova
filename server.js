const express = require("express");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// ─── プロキシルート ───────────────────────────────────────
// 使い方: https://your-proxy.onrender.com/p/https://www.youtube.com/
app.all("/p/*", (req, res) => {
  let targetUrl = req.params[0];

  // URL補完
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: isHttps ? 443 : 80,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: parsed.hostname,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "accept": "*/*",
      "accept-language": "ja,en;q=0.9",
    },
  };

  // 不要なヘッダ削除
  delete options.headers["x-forwarded-for"];
  delete options.headers["x-forwarded-host"];
  delete options.headers["x-forwarded-proto"];
  delete options.headers["connection"];
  delete options.headers["content-length"];

  const proxyReq = lib.request(options, (proxyRes) => {
    const contentType = proxyRes.headers["content-type"] || "";
    const isHtml = contentType.includes("text/html");

    // レスポンスヘッダを整形（iframe埋め込み可能にする）
    const headers = { ...proxyRes.headers };
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    delete headers["content-security-policy-report-only"];
    delete headers["cross-origin-embedder-policy"];
    delete headers["cross-origin-opener-policy"];
    delete headers["cross-origin-resource-policy"];
    delete headers["transfer-encoding"];

    res.writeHead(proxyRes.statusCode, headers);

    if (isHtml) {
      // HTMLをバッファしてURLを書き換え
      let data = "";
      proxyRes.on("data", (chunk) => (data += chunk));
      proxyRes.on("end", () => {
        let html = data
          .replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, url) => {
            if (
              url.startsWith("http://") ||
              url.startsWith("https://")
            ) {
              return `${attr}="/p/${url}"`;
            }
            if (url.startsWith("//")) {
              return `${attr}="/p/https:${url}"`;
            }
            return match;
          })
          .replace(
            /<base\s+href=["']([^"']+)["']/gi,
            "<base href=\"/p/$1\">"
          );
        res.end(html);
      });
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on("error", (err) => {
    res.status(502).send(`Proxy Error: ${err.message}`);
  });

  // POST/PUTボディ転送
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

// ─── ルート ───────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});   
