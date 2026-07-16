// WebSocket wiring: two path-scoped servers (`/ws` transcription relay,
// `/ws-agent` voice-agent relay) on one HTTP server. Each WebSocket.Server
// with its own `path` option would 400 upgrades for the other's path, so
// both use noServer and upgrades are routed manually.
const WebSocket = require("ws");

const { handleTranscribeConnection } = require("./transcribeRelay.js");
const { handleAgentConnection } = require("./agentRelay.js");

function attachWebSockets(server) {
  const transcribeWss = new WebSocket.Server({ noServer: true });
  const agentWss = new WebSocket.Server({ noServer: true });

  transcribeWss.on("connection", handleTranscribeConnection);
  agentWss.on("connection", handleAgentConnection);

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    const target = pathname === "/ws" ? transcribeWss : pathname === "/ws-agent" ? agentWss : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(request, socket, head, (ws) => {
      target.emit("connection", ws, request);
    });
  });
}

module.exports = { attachWebSockets };
