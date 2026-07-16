// LangGraph-based support agent for /api/chat (free browser voice mode).
// A prebuilt ReAct graph (agent node ⇄ tools node) drives the shared domain
// handlers, so provider differences (OpenAI-style tool_calls vs Gemini
// functionDeclarations) are handled by the LangChain chat-model adapters.
const { createReactAgent } = require("@langchain/langgraph/prebuilt");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");

const config = require("../config.js");
const { buildSupportPrompt } = require("../domain/prompt.js");
const { isPineconeConfigured, searchKnowledge, saveMemory, recallMemories } = require("../infra/rag.js");
const { isMongoConfigured, getClient, DB_NAME } = require("../infra/db.js");
const { buildChatModel, contentToText } = require("../llm/providers.js");
const { buildTools } = require("./tools.js");
const { getCustomerFacts, updateCustomerFacts } = require("./memory.js");

// Each ReAct step is 2 graph transitions (agent → tools); 10 allows ~4 tool
// rounds before the graph aborts.
const RECURSION_LIMIT = 10;

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

// Long-term memory recall: fetch past exchanges (any session) relevant to
// the question from the Pinecone memory namespace, formatted for the prompt.
async function recallPastConversations(question) {
  try {
    const memories = await recallMemories(question, 3);
    if (memories.length === 0) return undefined;
    console.log(`Long-term memory: recalled ${memories.length} exchange(s) for "${question}"`);
    return memories.map((m) => `[${m.savedAt || "earlier"}]\n${m.text}`).join("\n\n");
  } catch (error) {
    console.error("Memory recall error:", error);
    return undefined;
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
async function runSupportAgent(history, provider, sessionId, customerId) {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const context = { lastUserMessage: lastUser ? lastUser.content : "" };
  const useMemory = Boolean(sessionId) && isMongoConfigured();

  const [retrievedKnowledge, pastMemories, customerFacts] = await Promise.all([
    retrieveKnowledge(context.lastUserMessage),
    recallPastConversations(context.lastUserMessage),
    getCustomerFacts(customerId),
  ]);

  const systemPrompt = buildSupportPrompt({ retrievedKnowledge, pastMemories, customerFacts });
  if (config.debugPrompt) {
    console.log("=== SYSTEM PROMPT ===\n" + systemPrompt + "\n=== END PROMPT ===");
  }
  const agent = createReactAgent({
    llm: buildChatModel(provider),
    tools: buildTools(context),
    prompt: systemPrompt,
    ...(useMemory ? { checkpointSaver: await getCheckpointer() } : {}),
  });

  const messages = useMemory
    ? [new HumanMessage(context.lastUserMessage)]
    : history.map((m) =>
        m.role === "assistant" ? new AIMessage(m.content) : new HumanMessage(m.content)
      );
  const config_ = {
    recursionLimit: RECURSION_LIMIT,
    ...(useMemory ? { configurable: { thread_id: String(sessionId) } } : {}),
  };

  // Llama on Groq occasionally writes the tool call as literal text instead
  // of a structured call; Groq rejects that with tool_use_failed. One retry
  // usually recovers.
  let result;
  try {
    result = await agent.invoke({ messages }, config_);
  } catch (error) {
    if (!/tool_use_failed/.test(error.message || "")) throw error;
    result = await agent.invoke({ messages }, config_);
  }
  const finalMessage = result.messages[result.messages.length - 1];
  const reply = contentToText(finalMessage?.content).trim();

  // Persist the exchange to long-term memory (fire-and-forget — never delay
  // or fail the reply over it). "I don't know"-style replies are skipped:
  // saved failures outscore useful memories on similar questions and teach
  // the model to keep failing.
  const unhelpful = /i don'?t know|support@|email support|please repeat|didn'?t (catch|understand)/i;
  if (reply && !unhelpful.test(reply)) {
    saveMemory({ sessionId, userMessage: context.lastUserMessage, agentReply: reply }).catch(
      (error) => console.error("Memory save error:", error)
    );
    // Refresh the customer's durable profile from this exchange (also
    // fire-and-forget; a failed extraction just leaves the old profile).
    updateCustomerFacts({
      customerId,
      userMessage: context.lastUserMessage,
      agentReply: reply,
      provider,
    }).catch((error) => console.error("Customer memory update error:", error));
  }
  return reply;
}

module.exports = { runSupportAgent };
