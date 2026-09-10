const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// プロキシエンドポイント
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('url parameter required');

  try {
    const targetUrl = new URL(url);
    const response = await fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      let html = await response.text();
      // リソースURLをプロキシ経由に書き換え
      html = html.replace(/(src|href)=["'](?!\/proxy)(?!data:)(?!#)(https?:)?\/\//gi,
        (match, attr, quote, protocol) => {
          return `${attr}="/proxy?url=`;
        });
      // 上記は簡易版。以下のように正確に置換：
      html = html.replace(/(src|href)=["'](https?:\/\/[^"']+)["']/gi,
        (match, attr, urlVal) => {
          return `${attr}="/proxy?url=${encodeURIComponent(urlVal)}"`;
        });
      res.type('html').send(html);
    } else if (contentType.startsWith('image/')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.set('Content-Type', contentType).send(buffer);
    } else if (contentType.startsWith('application/javascript') || contentType.startsWith('text/javascript')) {
      res.type('js').send(await response.text());
    } else if (contentType.startsWith('text/css')) {
      res.type('css').send(await response.text());
    } else {
      res.redirect(targetUrl.href);
    }
  } catch (err) {
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy running on port ${port}`));   
