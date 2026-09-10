const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// プロキシルート: /proxy/https://example.com/...
app.all('/proxy/*', async (req, res) => {
  const targetUrl = req.params[0]; // https://example.com/...

  try {
    const url = new URL(targetUrl);
    const method = req.method;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'ja,en;q=0.9',
      ...req.headers,
    };
    // 不要なヘッダを削除
    delete headers.host;
    delete headers['content-length'];
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];

    const resp = await axios({
      method,
      url: targetUrl,
      headers,
      data: method !== 'GET' ? req.body : undefined,
      maxRedirects: 5,
      timeout: 30000,
      responseType: 'arraybuffer',
    });

    const contentType = resp.headers['content-type'] || '';
    const proxyBase = `https://${req.headers.host}/proxy`;

    if (contentType.includes('text/html')) {
      // HTML の場合：URL 書き換え + セキュリティヘッダ除去
      const $ = cheerio.load(Buffer.from(resp.data).toString('utf-8'));

      // X-Frame-Options / CSP を除去（レスポンスヘッダ側で処理）
      // リンク・スクリプト・CSS・画像の URL を書き換え
      const rewriteUrl = (originalUrl) => {
        if (!originalUrl) return originalUrl;
        if (originalUrl.startsWith('data:') || originalUrl.startsWith('blob:') || originalUrl.startsWith('#')) return originalUrl;
        try {
          const abs = new URL(originalUrl, targetUrl);
          return `${proxyBase}/${abs.toString()}`;
        } catch {
          return originalUrl;
        }
      };

      $('a[href]').each((_, el) => $(el).attr('href', rewriteUrl($(el).attr('href'))));
      $('img[src]').each((_, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));
      $('script[src]').each((_, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));
      $('link[href]').each((_, el) => $(el).attr('href', rewriteUrl($(el).attr('href'))));
      $('iframe[src]').each((_, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));
      $('source[src]').each((_, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));
      $('video[src]').each((_, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));
      $('audio[src]').each((_, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));

      // form の action
      $('form[action]').each((_, el) => $(el).attr('action', rewriteUrl($(el).attr('action'))));

      // meta refresh
      $('meta[http-equiv="refresh"]').each((_, el) => {
        let content = $(el).attr('content');
        content = content.replace(/url=([^;]+)/i, (m, url) => `url=${rewriteUrl(url.trim())}`);
        $(el).attr('content', content);
      });

      // CSS の background-image 等は JS 側で補完
      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'ALLOWALL',
        'Content-Security-Policy': "frame-ancestors 'self' *; object-src 'none'",
        'Access-Control-Allow-Origin': '*',
      });
      res.status(resp.status).send($.html());
    } else {
      // HTML 以外（画像・CSS・JS・動画等）はそのまま返す
      const safeHeaders = { ...resp.headers };
      delete safeHeaders['x-frame-options'];
      delete safeHeaders['content-security-policy'];
      delete safeHeaders['content-security-policy-report-only'];
      delete safeHeaders['cross-origin-opener-policy'];
      delete safeHeaders['cross-origin-embedder-policy'];
      safeHeaders['Access-Control-Allow-Origin'] = '*';

      res.set(safeHeaders);
      res.status(resp.status).send(Buffer.from(resp.data));
    }
  } catch (err) {
    res.status(502).send(`Proxy Error: ${err.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Proxy running on port ${PORT}`);
});   
