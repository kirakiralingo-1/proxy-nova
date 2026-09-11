(async () => {
  // Service Worker 登録
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  // Controller 初期化
  const { Controller } = $scramjetLoadController();
  const controller = new Controller({
    serviceworker: true,
    transport: new LibcurlClient({ wisp: `ws://${location.host}/wisp/` }),
    config: {
      scramjetPath: "/scram/scramjet.js",
      wasmPath: "/scram/scramjet.wasm",
      injectPath: "/controller/controller.inject.js",
    },
  });
  await controller.wait();

  // フレーム作成
  const iframe = document.createElement("iframe");
  document.getElementById("frame").appendChild(iframe);
  const frame = controller.createFrame(iframe);

  // ナビゲーション
  const go = () => frame.go(document.getElementById("url").value);
  document.getElementById("go").onclick = go;
  document.getElementById("url").onkeydown = (e) => e.key === "Enter" && go();

  frame.go("https://example.com");
})();   
