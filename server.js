const express = require("express");
const path = require("path");
const wisp = require("wisp-server-node");

const app = express();

// Wisp WebSocket transport
wisp.listen(app, {
  allowPrivateIPs: true,
  allowLoopbackIPs: true,
});

// Scramjet static files
app.use("/scram", express.static(
  path.join(__dirname, "node_modules/@mercuryworkshop/scramjet/dist")
));

// Custom frontend
app.use(express.static(path.join(__dirname, "public")));

app.listen(process.env.PORT || 3000, () => {
  console.log(`Proxy running on port ${process.env.PORT || 3000}`);
});   
