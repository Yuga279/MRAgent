// Central configuration: loads server/.env (explicit path so cwd doesn't
// matter) and exposes every environment value the app uses. All other modules
// depend on this instead of reading process.env directly, so configuration
// has one home and one load order.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const config = {
  port: process.env.PORT || 3000,

  // Deepgram (premium voice mode). Optional: without it the Deepgram
  // surfaces (/ws, /ws-agent, /api/tts) return errors but /api/chat works.
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",

  // Free (browser) mode LLM providers — at least one required for /api/chat.
  groqApiKey: process.env.GROQ_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",

  // MongoDB — orders, products, customer profiles, LangGraph checkpoints.
  mongoUri: process.env.MONGODB_URI || "",
  mongoDbName: process.env.MONGODB_DB || "mragent",

  // Pinecone — knowledge base + long-term conversational memory.
  pineconeApiKey: process.env.PINECONE_API_KEY || "",
  pineconeIndex: process.env.PINECONE_INDEX || "mragent-knowledge",

  // Test override for the data directory (knowledge.md).
  dataDir: process.env.MRAGENT_DATA_DIR || path.join(__dirname, "..", "data"),

  // Log the full system prompt per /api/chat request.
  debugPrompt: Boolean(process.env.DEBUG_PROMPT),
};

module.exports = config;
