import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { wisp } from "@mercuryworkshop/wisp-js";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

// COOP/COEP headers（クロスオリジン分離に必須）
app.addHook("onSend", async (req, reply) => {
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Embedder-Policy", "require-corp");
});

// Scramjetビルドファイルを配信
app.register(fastifyStatic, {
  prefix: "/scram/",
  root: scramjetPath,
});

// libcurl transport を配信
const libcurlDir = path.dirname(
  await import.meta.resolve("@mercuryworkshop/libcurl-transport")
);
app.register(fastifyStatic, {
  prefix: "/libcurl/",
  root: libcurlDir,
});

// bare-mux worker を配信
const baremuxDir = path.dirname(
  await import.meta.resolve("@mercuryworkshop/bare-mux")
);
app.register(fastifyStatic, {
  prefix: "/baremux/",
  root: baremuxDir,
});

// フロントエンド
app.register(fastifyStatic, {
  prefix: "/",
  root: path.join(__dirname, "..", "public"),
});

// Wisp WebSocket
app.server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/wisp/") {
    req.url = "/wisp/";
    wisp.routeRequest(req, socket, head);
    return;
  }
  socket.end();
});

const PORT = process.env.PORT || 8080;
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});   
