import { createServer } from "node:http";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { WispClient } from "@mercuryworkshop/wisp-js";
import { LibCurlTransport } from "@mercuryworkshop/libcurl-transport";
import { join } from "node:path";

const app = Fastify();

app.register(fastifyStatic, {
  root: scramjetPath,
  prefix: "/scram/",
});

app.get("/", (req, reply) => {
  reply.type("text/html").send(`
    <html>
    <head><meta charset="utf-8"><title>Proxy</title></head>
    <body>
      <script>
        const scramjet = new ScramjetController({
          files: {
            wasm: "/scram/scramjet.wasm.wasm",
            all: "/scram/scramjet.all.js",
            sync: "/scram/scramjet.sync.js",
          }
        });
        scramjet.init();
        navigator.serviceWorker.register("/scram/sw.js");
      </script>
    </body>
    </html>
  `);
});

const wisp = new WispClient({
  transport: new LibCurlTransport(),
});

const PORT = process.env.PORT || 8080;
const server = createServer();

server.on("request", (req, res) => {
  if (req.url.startsWith("/bare/")) {
    wisp.handleRequest(req, res);
  } else {
    app.server.emit("request", req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/bare/")) {
    wisp.handleUpgrade(req, socket, head);
  } else {
    socket.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});   
