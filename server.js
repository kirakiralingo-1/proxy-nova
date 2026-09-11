import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 1337;

const app = express();

app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// 静的ファイル — node_modules パスを直接指定
app.use("/scram/", express.static(
  path.resolve(__dirname, "node_modules/@mercuryworkshop/scramjet")
));
app.use("/libcurl/", express.static(
  path.resolve(__dirname, "node_modules/@mercuryworkshop/libcurl-transport")
));
app.use(express.static(path.resolve(__dirname, "public")));

const server = createServer(app);

// Wisp WebSocket
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url ?? "/", "http://localhost").pathname;
  if (p === "/wisp/") {
    req.url = p;
    wisp.routeRequest(req, socket, head);
    return;
  }
  socket.end();
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));   
