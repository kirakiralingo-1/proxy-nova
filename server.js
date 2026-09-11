import express from "express";
import path from "node:path";
import { createServer } from "node:http";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

const app = express();
const PORT = process.env.PORT || 1337;

// COOP/COEP（SharedArrayBuffer 必須）
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// 静的ファイルマウント
const dirOf = (specifier) => path.dirname(require.resolve(specifier));

app.use("/scram/", express.static(scramjetPath));
app.use("/controller/", express.static(dirOf("@mercuryworkshop/scramjet-controller")));
app.use("/utils/", express.static(dirOf("@mercuryworkshop/scramjet-utils")));
app.use("/libcurl/", express.static(dirOf("@mercuryworkshop/libcurl-transport")));
app.use(express.static("public"));

const server = createServer(app);

// Wisp WebSocket
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url ?? "/", "http://localhost").pathname;
  if (p === "/wisp/") {
    wisp.routeRequest(req, socket, head);
    return;
  }
  socket.end();
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));   
