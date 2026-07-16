// /ws-agent — relay between the browser and the Deepgram Voice Agent API
// (STT + LLM + TTS). Talks to the agent WebSocket endpoint directly (NOT the
// SDK: its agent socket JSON-parses every frame, which breaks on binary agent
// audio). Intercepts FunctionCallRequest frames and executes the shared
// domain handlers server-side; all frames are still forwarded to the browser.
// Text frames from the browser (e.g. InjectUserMessage) pass through to
// Deepgram — useful for testing without a mic.
const WebSocket = require("ws");

const config = require("../config.js");
const { buildSupportPrompt } = require("../domain/prompt.js");
const { FUNCTION_HANDLERS, SUPPORT_FUNCTIONS } = require("../domain/functions.js");

const AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";
const GREETING = "Hi! Thanks for calling Acme Gadgets support. How can I help you today?";

function buildAgentSettings() {
  return {
    type: "Settings",
    audio: {
      // Sample rates must match the browser's capture/playback (AgentPanel).
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
      greeting: GREETING,
    },
  };
}

async function handleFunctionCallRequest(dgWs, message, context = {}) {
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
      try {
        result = await handler(args, context);
      } catch (error) {
        console.error(`Function ${call.name} failed:`, error);
        result = { error: "Function temporarily unavailable." };
      }
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

function handleAgentConnection(browserWs) {
  console.log("Agent client connected");

  if (!config.deepgramApiKey) {
    browserWs.send(JSON.stringify({ type: "Error", description: "DEEPGRAM_API_KEY not configured" }));
    browserWs.close();
    return;
  }

  const dgWs = new WebSocket(AGENT_URL, {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
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
          handleFunctionCallRequest(dgWs, message, conversationContext).catch((error) =>
            console.error("FunctionCallRequest handling failed:", error)
          );
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
}

module.exports = { handleAgentConnection };
