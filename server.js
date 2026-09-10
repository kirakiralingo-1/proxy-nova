import express from "express";
import { createServer } from "node:http";
import { createBareServer } from "@tomphttp/bare-server-node";
import { createWispServer } from "wisp-server-node";
import { publicPath } from "ultraviolet-static";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const bare = createBareServer("/bare/");
const wisp = createWispServer("/wisp/");
const app = express();

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// 静的ファイル
app.use(express.static(join(__dirname, "public")));
app.use("/uv/", express.static(uvPath));
app.use(express.static(publicPath));

// フォールバック 404
app.use((req, res) => {
  res.status(404).sendFile(join(__dirname, "public", "index.html"));
});

const server = createServer();

server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
  } else if (wisp.shouldRoute(req)) {
    wisp.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else if (wisp.shouldRoute(req)) {
    wisp.routeUpgrade(req, socket, head);
  } else {
    socket.end();
  }
});

const port = parseInt(process.env.PORT || "8080");
server.listen(port, () => {
  console.log(`UV Proxy running on port ${port}`);
});

function shutdown() {
  server.close();
  bare.close();
  wisp.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);   
