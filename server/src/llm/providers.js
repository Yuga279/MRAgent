// Single factory for chat models. Everything that needs an LLM goes through
// here, so adding a provider (or changing a model id) is a one-file change.
// Providers are required lazily so the server boots even if one SDK is absent.
const config = require("../config.js");

// Model choices per role: "chat" answers the customer; "extractor" is the
// cheap background model that maintains the customer profile.
const MODELS = {
  groq: { chat: "llama-3.3-70b-versatile", extractor: "llama-3.1-8b-instant" },
  gemini: { chat: "gemini-2.5-flash", extractor: "gemini-2.5-flash" },
};

function availableProviders() {
  return {
    groq: Boolean(config.groqApiKey),
    gemini: Boolean(config.geminiApiKey),
  };
}

// Resolve the requested provider against configured API keys, falling back to
// whichever is available. Returns null when no LLM is configured at all.
function resolveProvider(requested) {
  const available = availableProviders();
  if (available[requested]) return requested;
  if (available.groq) return "groq";
  if (available.gemini) return "gemini";
  return null;
}

function buildChatModel(provider, role = "chat") {
  if (provider === "groq") {
    const { ChatGroq } = require("@langchain/groq");
    return new ChatGroq({
      model: MODELS.groq[role],
      apiKey: config.groqApiKey,
      temperature: role === "extractor" ? 0 : 0.3,
      // Tool-call JSON counts against this cap; too tight and Groq errors
      // with tool_use_failed. Reply brevity is enforced by the prompt.
      maxTokens: 512,
    });
  }
  const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
  return new ChatGoogleGenerativeAI({
    model: MODELS.gemini[role],
    apiKey: config.geminiApiKey,
    temperature: role === "extractor" ? 0 : 0.3,
    // Generous cap: 2.5-flash "thinking" tokens count against this budget and
    // a tight cap truncates the visible short reply.
    maxOutputTokens: 1024,
  });
}

// Flatten a LangChain message's content (string or content-block array) to text.
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
  }
  return "";
}

module.exports = { buildChatModel, resolveProvider, contentToText };
