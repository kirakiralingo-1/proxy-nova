const frame = document.getElementById('frame');
const urlInput = document.getElementById('urlInput');
const status = document.getElementById('status');
const history = [];
let historyIndex = -1;

function navigate(url) {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { url = new URL(url).href; } catch { return; }

  // プロキシURLへ
  const proxyUrl = `/p?url=${encodeURIComponent(url)}`;
  frame.src = proxyUrl;
  urlInput.value = url.replace(/^https?:\/\//, '');

  // 履歴管理
  if (historyIndex < history.length - 1) history.splice(historyIndex + 1);
  history.push(url);
  historyIndex = history.length - 1;
  status.textContent = url;
}

document.getElementById('goBtn').onclick = () => navigate(urlInput.value.trim());
urlInput.onkeydown = (e) => { if (e.key === 'Enter') navigate(urlInput.value.trim()); };
document.getElementById('reloadBtn').onclick = () => { frame.src = frame.src; };
document.getElementById('backBtn').onclick = () => {
  if (historyIndex > 0) { historyIndex--; frame.src = `/p?url=${encodeURIComponent(history[historyIndex])}`; }
};
document.getElementById('forwardBtn').onclick = () => {
  if (historyIndex < history.length - 1) { historyIndex++; frame.src = `/p?url=${encodeURIComponent(history[historyIndex])}`; }
};

// 初期表示
navigate('https://www.bing.com');   
