const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { DeepgramClient } = require("@deepgram/sdk");
const fs = require("fs");

// Support-agent domain logic (knowledge base, order functions with consent
// guards, prompt) — in its own module so it can be unit-tested.
const {
  FUNCTION_HANDLERS,
  SUPPORT_FUNCTIONS,
  buildSupportPrompt,
  sanitizeReply,
} = require("./src/support.js");

const app = express();
const server = http.createServer(app);
// Two WebSocket endpoints on one HTTP server: each WebSocket.Server with its
// own `path` would 400 upgrades for the other's path, so route upgrades manually.
const wss = new WebSocket.Server({ noServer: true });
const agentWss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  const target = pathname === "/ws" ? wss : pathname === "/ws-agent" ? agentWss : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (ws) => {
    target.emit("connection", ws, request);
  });
});

const apiKey = process.env.DEEPGRAM_API_KEY;

if (!apiKey) {
  console.warn(
    "Warning: DEEPGRAM_API_KEY not set — Deepgram mode (/ws, /ws-agent, /api/tts) is disabled. Browser (free) mode still works."
  );
}

app.use(express.json());

// Deepgram TTS caps text at 2000 characters per request; split long
// transcripts on sentence boundaries and concatenate the MP3 output.
const TTS_CHUNK_LIMIT = 1900;

function chunkText(text) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > TTS_CHUNK_LIMIT) {
      chunks.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

app.post("/api/tts", async (req, res) => {
  if (!apiKey) {
    return res.status(400).json({ error: "DEEPGRAM_API_KEY not configured" });
  }
  const text = (req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "No text provided" });
  }

  try {
    const client = new DeepgramClient({ apiKey });
    const buffers = [];
    for (const chunk of chunkText(text)) {
      const audio = await client.speak.v1.audio.generate({
        text: chunk,
        model: "aura-2-thalia-en",
      });
      buffers.push(Buffer.from(await audio.arrayBuffer()));
    }
    res.set("Content-Type", "audio/mpeg").send(Buffer.concat(buffers));
  } catch (error) {
    console.error("TTS error:", error);
    res.status(502).json({ error: error.message || "TTS request failed" });
  }
});

// Text chat endpoint for the free (browser speech) mode — no Deepgram involved.
// The browser does STT/TTS itself and sends conversation text here; the reply
// comes from Groq or Gemini with the same knowledge base + order lookup tools.
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_TOOL_ROUNDS = 4;

function lastUserContent(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return "";
}

async function chatWithGroq(history) {
  const messages = [
    { role: "system", content: buildSupportPrompt() },
    ...history,
  ];
  const context = { lastUserMessage: lastUserContent(history) };
  const tools = SUPPORT_FUNCTIONS.map((fn) => ({ type: "function", function: fn }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, tools, temperature: 0.3, max_tokens: 100 }),
    });
    if (!response.ok) {
      throw new Error(`Groq API error ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const message = (await response.json()).choices?.[0]?.message;
    if (!message) throw new Error("Groq returned no message");

    if (message.tool_calls?.length) {
      messages.push(message);
      for (const call of message.tool_calls) {
        const handler = FUNCTION_HANDLERS[call.function?.name];
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          // leave args empty
        }
        const result = handler ? handler(args, context) : { error: `Unknown function: ${call.function?.name}` };
        console.log(`Chat function call (groq): ${call.function?.name} →`, result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }
    return message.content || "";
  }
  throw new Error("Too many function-call rounds");
}

async function chatWithGemini(history) {
  const context = { lastUserMessage: lastUserContent(history) };
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  let retriedMalformed = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSupportPrompt() }] },
          contents,
          tools: [{ functionDeclarations: SUPPORT_FUNCTIONS }],
          // thinkingBudget 0 disables 2.5-flash "thinking", which otherwise
          // consumes the output budget and truncates short replies.
          generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (!response.ok) {
      throw new Error(`Gemini API error ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const candidate = (await response.json()).candidates?.[0];
    if (candidate?.finishReason === "MALFORMED_FUNCTION_CALL" && !retriedMalformed) {
      retriedMalformed = true;
      round--;
      continue;
    }
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length > 0) {
      contents.push(candidate.content);
      contents.push({
        role: "user",
        parts: functionCalls.map((p) => {
          const handler = FUNCTION_HANDLERS[p.functionCall.name];
          const result = handler
            ? handler(p.functionCall.args || {}, context)
            : { error: `Unknown function: ${p.functionCall.name}` };
          console.log(`Chat function call (gemini): ${p.functionCall.name} →`, result);
          return {
            functionResponse: { name: p.functionCall.name, response: { result } },
          };
        }),
      });
      continue;
    }
    const text = parts.map((p) => p.text || "").join("").trim();
    if (text) return text;
    throw new Error(`Gemini returned no text (finishReason: ${candidate?.finishReason || "unknown"})`);
  }
  throw new Error("Too many function-call rounds");
}

app.post("/api/chat", async (req, res) => {
  const { messages = [], provider } = req.body || {};

  const available = {
    groq: Boolean(process.env.GROQ_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  };
  const chosen = available[provider] ? provider : available.groq ? "groq" : available.gemini ? "gemini" : null;
  if (!chosen) {
    return res.status(400).json({
      error: "No LLM API key configured. Add GROQ_API_KEY or GEMINI_API_KEY to server/.env and restart.",
    });
  }

  const history = messages
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .slice(-30);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "messages must end with a user message" });
  }

  try {
    const reply = sanitizeReply(await (chosen === "groq" ? chatWithGroq : chatWithGemini)(history));
    if (!reply) throw new Error("The model returned an empty reply");
    res.json({ reply, provider: chosen });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(502).json({ error: error.message || "Chat request failed" });
  }
});

// Serve the built React app (run `npm run build` in ../client first, or use
// the Vite dev server on port 5173 which proxies /ws here).
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

wss.on("connection", async (ws) => {
  console.log("Client connected");

  if (!apiKey) {
    ws.send(JSON.stringify({ type: "error", message: "DEEPGRAM_API_KEY not configured" }));
    ws.close();
    return;
  }

  let connection = null;
  let isConnected = false;
  let messageQueue = [];

  try {
    const client = new DeepgramClient({ apiKey });

    // Create a live connection
    connection = await client.listen.v1.connect({
      model: "nova-3",
      language: "en",
      punctuate: true,
      interim_results: true,
    });

    connection.on("open", () => {
      console.log("Deepgram connection opened");
      isConnected = true;
      ws.send(JSON.stringify({ type: "status", message: "Connected" }));
      
      // Flush queued messages
      while (messageQueue.length > 0) {
        const data = messageQueue.shift();
        try {
          if (connection.socket) {
            connection.socket.send(data);
          }
        } catch (error) {
          console.error("Error flushing queued message:", error);
        }
      }
    });

    connection.on("message", (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });

    connection.on("error", (error) => {
      console.error("Deepgram error:", error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: error.message }));
      }
    });

    connection.on("close", () => {
      console.log("Deepgram connection closed");
      isConnected = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    ws.on("message", (data) => {
      try {
        if (isConnected && connection && connection.socket) {
          connection.socket.send(data);
        } else if (!isConnected) {
          // Queue message until connection is ready
          messageQueue.push(data);
        }
      } catch (error) {
        console.error("Error sending to Deepgram:", error);
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
      if (connection && connection.socket) {
        try {
          connection.socket.close();
        } catch (e) {
          console.error("Error closing connection:", e);
        }
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    await connection.connect();
  } catch (error) {
    console.error("Connection error:", error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: error.message }));
      ws.close();
    }
  }
});

// Voice Agent relay: browser mic PCM → Deepgram Agent (STT + LLM + TTS) →
// agent audio (binary) and events (JSON) back to the browser. The SDK's agent
// socket JSON-parses every frame, which breaks on binary audio, so we talk to
// the agent WebSocket endpoint directly.
const AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";


function buildAgentSettings() {
  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: 24000 },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      listen: { provider: { type: "deepgram", model: "nova-3" } },
      think: {
        provider: { type: "open_ai", model: "gpt-4o-mini", temperature: 0.5 },
        prompt: buildSupportPrompt(),
        functions: SUPPORT_FUNCTIONS,
      },
      speak: { provider: { type: "deepgram", model: "aura-2-thalia-en" } },
      greeting: "Hi! Thanks for calling Acme Gadgets support. How can I help you today?",
    },
  };
}

function handleFunctionCallRequest(dgWs, message, context = {}) {
  for (const call of message.functions || []) {
    if (!call.client_side) continue;
    const handler = FUNCTION_HANDLERS[call.name];
    let result;
    if (!handler) {
      result = { error: `Unknown function: ${call.name}` };
    } else {
      let args = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        // leave args empty
      }
      result = handler(args, context);
    }
    console.log(`Function call: ${call.name}(${call.arguments}) →`, result);
    dgWs.send(
      JSON.stringify({
        type: "FunctionCallResponse",
        id: call.id,
        name: call.name,
        content: JSON.stringify(result),
      })
    );
  }
}

agentWss.on("connection", (browserWs) => {
  console.log("Agent client connected");

  if (!apiKey) {
    browserWs.send(JSON.stringify({ type: "Error", description: "DEEPGRAM_API_KEY not configured" }));
    browserWs.close();
    return;
  }

  const dgWs = new WebSocket(AGENT_URL, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  const pending = [];

  dgWs.on("open", () => {
    console.log("Deepgram agent connection opened");
    dgWs.send(JSON.stringify(buildAgentSettings()));
    while (pending.length > 0) {
      dgWs.send(pending.shift());
    }
  });

  // Track the customer's most recent utterance so function handlers can
  // verify consent server-side (same guard as the free-mode /api/chat path).
  const conversationContext = { lastUserMessage: "" };

  dgWs.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "ConversationText" && message.role === "user") {
          conversationContext.lastUserMessage = message.content || "";
        }
        if (message.type === "FunctionCallRequest") {
          handleFunctionCallRequest(dgWs, message, conversationContext);
        }
      } catch {
        // forward unparseable text frames as-is
      }
    }
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(data, { binary: isBinary });
    }
  });

  dgWs.on("close", () => {
    console.log("Deepgram agent connection closed");
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close();
    }
  });

  dgWs.on("error", (error) => {
    console.error("Deepgram agent error:", error);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "Error", description: error.message }));
      browserWs.close();
    }
  });

  browserWs.on("message", (data, isBinary) => {
    if (dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(data, { binary: isBinary });
    } else if (dgWs.readyState === WebSocket.CONNECTING) {
      pending.push(data);
    }
  });

  browserWs.on("close", () => {
    console.log("Agent client disconnected");
    if (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING) {
      dgWs.close();
    }
  });

  browserWs.on("error", (error) => {
    console.error("Agent client WebSocket error:", error);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
