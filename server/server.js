const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { DeepgramClient } = require("@deepgram/sdk");
const fs = require("fs");

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
  console.error("Error: DEEPGRAM_API_KEY environment variable not set");
  process.exit(1);
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

// Customer data lives in server/data/ — knowledge.md is injected into the
// agent's prompt on every new conversation, orders.json backs the
// get_order_status function the agent can call mid-conversation.
const DATA_DIR = path.join(__dirname, "data");

function loadKnowledge() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, "knowledge.md"), "utf8");
  } catch {
    return "";
  }
}

function getOrderStatus(orderId) {
  try {
    const orders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "orders.json"), "utf8"));
    const order = orders.find((o) => String(o.order_id) === String(orderId).trim());
    if (!order) {
      return { found: false, message: `No order found with ID ${orderId}. Ask the customer to double-check the order number.` };
    }
    return { found: true, ...order };
  } catch (error) {
    console.error("Order lookup error:", error);
    return { found: false, message: "The order system is temporarily unavailable." };
  }
}

const FUNCTION_HANDLERS = {
  get_order_status: (args) => getOrderStatus(args.order_id),
};

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
        prompt: [
          "You are a friendly customer support agent for the company described in the knowledge base below.",
          "You are speaking with a customer over voice, so keep replies short, natural, and conversational — one or two sentences unless more detail is needed.",
          "Answer ONLY from the knowledge base and the tools available to you. If the customer asks about an order, ask for their order number and use the get_order_status function.",
          "If you don't know the answer or the request is outside your knowledge, say so and offer the support email instead of guessing.",
          "",
          "=== KNOWLEDGE BASE ===",
          loadKnowledge(),
        ].join("\n"),
        functions: [
          {
            name: "get_order_status",
            description:
              "Look up the current status of a customer's order (shipping status, tracking number, delivery estimate) by its order number.",
            parameters: {
              type: "object",
              properties: {
                order_id: {
                  type: "string",
                  description: "The customer's order number, e.g. 1001",
                },
              },
              required: ["order_id"],
            },
          },
        ],
      },
      speak: { provider: { type: "deepgram", model: "aura-2-thalia-en" } },
      greeting: "Hi! Thanks for calling Acme Gadgets support. How can I help you today?",
    },
  };
}

function handleFunctionCallRequest(dgWs, message) {
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
      result = handler(args);
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

  dgWs.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "FunctionCallRequest") {
          handleFunctionCallRequest(dgWs, message);
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
