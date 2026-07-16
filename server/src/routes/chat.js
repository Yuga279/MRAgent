// POST /api/chat — text chat for the free (browser speech) mode; no Deepgram
// involved. The browser does STT/TTS itself and sends conversation text here;
// the reply comes from the LangGraph ReAct agent on Groq or Gemini.
const express = require("express");

const { runSupportAgent } = require("../agent/agentGraph.js");
const { sanitizeReply } = require("../domain/prompt.js");
const { resolveProvider } = require("../llm/providers.js");

const HISTORY_LIMIT = 30;

const router = express.Router();

router.post("/api/chat", async (req, res) => {
  const { messages = [], provider, sessionId, customerId } = req.body || {};

  const chosen = resolveProvider(provider);
  if (!chosen) {
    return res.status(400).json({
      error: "No LLM API key configured. Add GROQ_API_KEY or GEMINI_API_KEY to server/.env and restart.",
    });
  }

  const history = messages
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .slice(-HISTORY_LIMIT);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "messages must end with a user message" });
  }

  try {
    const reply = sanitizeReply(await runSupportAgent(history, chosen, sessionId, customerId));
    if (!reply) throw new Error("The model returned an empty reply");
    res.json({ reply, provider: chosen });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(502).json({ error: error.message || "Chat request failed" });
  }
});

module.exports = router;
