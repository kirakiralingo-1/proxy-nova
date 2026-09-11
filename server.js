const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Scramjet の dist ファイルを /scram/ 配下で配信
const scramjetDist = path.join(
  __dirname, 'node_modules', '@mercuryworkshop', 'scramjet', 'dist'
);
app.use('/scram', express.static(scramjetDist));

// 公開ファイル
app.use(express.static('public'));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`Scramjet proxy on :${PORT}`)
);   
