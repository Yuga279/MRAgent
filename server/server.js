// Composition root: assembles the HTTP app, WebSocket relays, and static
// client hosting. All behavior lives in src/ — routes/ (HTTP), ws/ (relays),
// agent/ (LLM orchestration), domain/ (business rules), infra/ (Mongo,
// Pinecone), llm/ (model factory), config.js (env).
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");

const config = require("./src/config.js");
const ttsRouter = require("./src/routes/tts.js");
const chatRouter = require("./src/routes/chat.js");
const { attachWebSockets } = require("./src/ws/index.js");

if (!config.deepgramApiKey) {
  console.warn(
    "Warning: DEEPGRAM_API_KEY not set — Deepgram mode (/ws, /ws-agent, /api/tts) is disabled. Browser (free) mode still works."
  );
}

const app = express();
app.use(express.json());
app.use(ttsRouter);
app.use(chatRouter);

// Serve the built React app (run `npm run build` in ../client first, or use
// the Vite dev server on port 5173 which proxies /ws, /ws-agent, /api here).
const clientDist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
} else {
  app.get("/", (req, res) => {
    res
      .status(503)
      .send("React app not built. Run `npm run build`, or use `npm run dev` for the Vite dev server.");
  });
}

const server = http.createServer(app);
attachWebSockets(server);

server.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});
