import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { path as scramjetPath } from "@mercuryworkshop/scramjet/path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 1337;

const fastify = Fastify({ logger: true });

// COOP/COEP
fastify.addHook("onSend", async (req, reply) => {
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Embedder-Policy", "require-corp");
});

// Scramjet 静的ファイル
await fastify.register(fastifyStatic, {
  root: scramjetPath,
  prefix: "/scram/",
});

// Libcurl transport
await fastify.register(fastifyStatic, {
  root: path.resolve(__dirname, "node_modules/@mercuryworkshop/libcurl-transport/dist"),
  prefix: "/libcurl/",
});

// public
await fastify.register(fastifyStatic, {
  root: path.resolve(__dirname, "public"),
  prefix: "/",
});

// Wisp WebSocket — raw socket を渡す
const server = fastify.server;
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/wisp/") {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
});

await fastify.listen({ port: PORT, host: "0.0.0.0" });   
