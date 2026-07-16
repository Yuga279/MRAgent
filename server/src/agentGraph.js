// LangGraph-based support agent for /api/chat (free browser voice mode).
// Replaces the hand-rolled Groq/Gemini function-call loops: a prebuilt ReAct
// graph (agent node ⇄ tools node) drives the same domain handlers from
// support.js, so provider differences (OpenAI-style tool_calls vs Gemini
// functionDeclarations) are handled by the LangChain chat-model adapters.
const { createReactAgent } = require("@langchain/langgraph/prebuilt");
const { ChatGroq } = require("@langchain/groq");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { tool } = require("@langchain/core/tools");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const { z } = require("zod");

const { FUNCTION_HANDLERS, buildSupportPrompt } = require("./support.js");
const { isPineconeConfigured, searchKnowledge } = require("./rag.js");
const { isMongoConfigured, getClient, DB_NAME } = require("./db.js");

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODEL = "gemini-2.5-flash";
// Each ReAct step is 2 graph transitions (agent → tools); 10 allows ~4 tool
// rounds like the old MAX_TOOL_ROUNDS before the graph aborts.
const RECURSION_LIMIT = 10;

// Tools are built per request so they close over the conversation context
// (lastUserMessage drives the server-side purchase-consent guard).
function buildTools(context) {
  const wrap = (result) => JSON.stringify(result);

  const tools = [
    tool(
      async ({ order_id }) => wrap(await FUNCTION_HANDLERS.get_order_status({ order_id }, context)),
      {
        name: "get_order_status",
        description:
          "Look up the current status of a customer's order (shipping status, tracking number, delivery estimate) by its order number.",
        schema: z.object({
          order_id: z.string().describe("The customer's order number, e.g. 1001"),
        }),
      }
    ),
    tool(
      async ({ product }) => wrap(await FUNCTION_HANDLERS.get_product_details({ product }, context)),
      {
        name: "get_product_details",
        description:
          "Look up a catalog product's exact price and description by name. Use it to answer product questions and to verify the product name before placing an order.",
        schema: z.object({
          product: z.string().describe("Product name (or part of it), e.g. HomeCam 360"),
        }),
      }
    ),
    tool(
      async ({ product, shipping, customer_confirmed }) =>
        wrap(await FUNCTION_HANDLERS.place_order({ product, shipping, customer_confirmed }, context)),
      {
        name: "place_order",
        description:
          "Place a new order for a catalog product. Call ONLY after the customer has explicitly said yes to buying this exact product — never call it for unclear, garbled, or meta questions. Returns the new order number.",
        schema: z.object({
          product: z.string().describe("Exact product name from the catalog, e.g. HomeCam 360"),
          shipping: z
            .enum(["standard", "express"])
            .optional()
            .describe("Shipping method the customer chose (default standard)"),
          customer_confirmed: z
            .boolean()
            .describe(
              "true ONLY if the customer's most recent message explicitly confirms they want to buy this product. Never guess or assume."
            ),
        }),
      }
    ),
  ];

  return tools;
}

function buildModel(provider) {
  if (provider === "groq") {
    return new ChatGroq({
      model: GROQ_MODEL,
      apiKey: process.env.GROQ_API_KEY,
      temperature: 0.3,
      // Tool-call JSON counts against this cap; too tight and Groq errors
      // with tool_use_failed. Reply brevity is enforced by the prompt.
      maxTokens: 512,
    });
  }
  return new ChatGoogleGenerativeAI({
    model: GEMINI_MODEL,
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.3,
    // Generous cap: 2.5-flash "thinking" tokens count against this budget and
    // a tight cap truncates the visible one-sentence reply.
    maxOutputTokens: 1024,
  });
}

// Retrieval step: query Pinecone with the customer's question and return the
// matching chunks as prompt text (retrieve-then-generate RAG). Tool-based
// retrieval was tried first but Llama on Groq reliably garbles the
// search_knowledge call, so the chat path injects context up front instead.
async function retrieveKnowledge(question) {
  if (!isPineconeConfigured()) return "(knowledge base not configured — say so and offer the support email)";
  try {
    const result = await searchKnowledge(question, 3);
    if (!result.found) return "(no relevant knowledge base entries found)";
    return result.results.map((r) => r.text).join("\n\n");
  } catch (error) {
    console.error("Knowledge retrieval error:", error);
    return "(knowledge base temporarily unavailable — say so and offer the support email)";
  }
}

// Conversational memory: LangGraph checkpoints stored in MongoDB, keyed by
// the browser session's thread_id. Lazily created so the server boots without
// the mongodb packages when Mongo is not configured.
let checkpointerPromise = null;

function getCheckpointer() {
  if (!checkpointerPromise) {
    checkpointerPromise = (async () => {
      const { MongoDBSaver } = require("@langchain/langgraph-checkpoint-mongodb");
      return new MongoDBSaver({ client: await getClient(), dbName: DB_NAME });
    })();
  }
  return checkpointerPromise;
}

// history: [{role: "user"|"assistant", content}], ending with a user message.
// Returns the agent's final text reply. With Mongo + a sessionId the graph
// checkpointer holds the conversation (only the newest user message is fed
// in); otherwise the client-sent history is replayed statelessly.
async function runSupportAgent(history, provider, sessionId) {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const context = { lastUserMessage: lastUser ? lastUser.content : "" };
  const useMemory = Boolean(sessionId) && isMongoConfigured();

  const agent = createReactAgent({
    llm: buildModel(provider),
    tools: buildTools(context),
    prompt: buildSupportPrompt({ retrievedKnowledge: await retrieveKnowledge(context.lastUserMessage) }),
    ...(useMemory ? { checkpointSaver: await getCheckpointer() } : {}),
  });

  const messages = useMemory
    ? [new HumanMessage(context.lastUserMessage)]
    : history.map((m) =>
        m.role === "assistant" ? new AIMessage(m.content) : new HumanMessage(m.content)
      );
  const config = {
    recursionLimit: RECURSION_LIMIT,
    ...(useMemory ? { configurable: { thread_id: String(sessionId) } } : {}),
  };

  // Llama on Groq occasionally writes the tool call as literal text instead
  // of a structured call; Groq rejects that with tool_use_failed. One retry
  // usually recovers.
  let result;
  try {
    result = await agent.invoke({ messages }, config);
  } catch (error) {
    if (!/tool_use_failed/.test(error.message || "")) throw error;
    result = await agent.invoke({ messages }, config);
  }
  const finalMessage = result.messages[result.messages.length - 1];
  const content = finalMessage?.content;
  if (typeof content === "string") return content;
  // Content blocks (some providers return an array of parts).
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p.text || "")).join("").trim();
  }
  return "";
}

module.exports = { runSupportAgent, buildTools, GROQ_MODEL, GEMINI_MODEL };
