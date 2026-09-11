import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { createRequire } from "node:module";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const PORT = process.env.PORT || 1337;

const fastify = Fastify({ logger: true });

// COOP/COEP ヘッダー
fastify.addHook("onSend", async (req, reply) => {
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Embedder-Policy", "require-corp");
});

// 静的ファイル
const scramDir = require.resolve("@mercuryworkshop/scramjet/dist/scramjet.all.js");
const scramRoot = path.dirname(scramDir);

await fastify.register(fastifyStatic, {
  root: scramRoot,
  prefix: "/scram/",
});

const libcurlDir = path.dirname(
  require.resolve("@mercuryworkshop/libcurl-transport")
);
await fastify.register(fastifyStatic, {
  root: libcurlDir,
  prefix: "/libcurl/",
});

await fastify.register(fastifyStatic, {
  root: path.resolve("public"),
  prefix: "/",
});

// Wisp WebSocket
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  wisp.routeRequest({ socket: ws, head: Buffer.alloc(0) });
});

const server = fastify.server;
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/wisp/") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

await fastify.listen({ port: PORT, host: "0.0.0.0" });   
