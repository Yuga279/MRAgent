// Durable customer memory: a per-customer profile of extracted facts
// ("prefers express shipping", "owns a HomeCam 360") stored in the MongoDB
// `customer_memory` collection, keyed by the browser's persistent customerId.
// Unlike the Pinecone exchange memory (infra/rag.js) which recalls raw past
// exchanges by similarity, this is a small structured profile injected into
// every prompt for the same customer. Requires MONGODB_URI; without it both
// functions are no-ops.
const { isMongoConfigured, getCustomerMemoryCollection } = require("../infra/db.js");
const { buildChatModel, contentToText } = require("../llm/providers.js");

const MAX_FACTS = 12;

async function getCustomerFacts(customerId) {
  if (!customerId || !isMongoConfigured()) return [];
  try {
    const doc = await (await getCustomerMemoryCollection()).findOne(
      { customer_id: String(customerId) },
      { projection: { _id: 0, facts: 1 } }
    );
    return Array.isArray(doc?.facts) ? doc.facts : [];
  } catch (error) {
    console.error("Customer memory read error:", error);
    return [];
  }
}

// Pull the first JSON array out of a model reply that may be wrapped in
// code fences or prose.
function parseFactArray(text) {
  const match = String(text || "").match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((f) => typeof f === "string" && f.trim())
      .map((f) => f.trim())
      .slice(0, MAX_FACTS);
  } catch {
    return null;
  }
}

// Merge the latest exchange into the customer's fact list. The extractor is
// given the existing facts and returns the updated full list, so it can add,
// rewrite, and drop stale facts in one pass. Callers should NOT await this on
// the reply path — it is designed to run in the background.
async function updateCustomerFacts({ customerId, userMessage, agentReply, provider }) {
  if (!customerId || !isMongoConfigured()) return;
  if (!userMessage || !agentReply) return;

  const existing = await getCustomerFacts(customerId);
  const prompt = [
    "You maintain a customer profile for a support agent. Given the existing facts and the latest exchange, return the UPDATED full list of durable facts about this customer as a JSON array of short strings.",
    `Rules: keep at most ${MAX_FACTS} facts; only durable facts useful in FUTURE calls (products owned or considered, preferences, open issues, order numbers, name if given); no transient chit-chat; drop facts the exchange makes obsolete; if nothing changed, return the existing list unchanged. Output ONLY the JSON array.`,
    "",
    `Existing facts: ${JSON.stringify(existing)}`,
    `Customer said: ${JSON.stringify(userMessage)}`,
    `Agent replied: ${JSON.stringify(agentReply)}`,
  ].join("\n");

  const result = await buildChatModel(provider, "extractor").invoke(prompt);
  const facts = parseFactArray(contentToText(result.content));
  if (!facts) return; // unparseable extraction → keep the old profile untouched

  await (await getCustomerMemoryCollection()).updateOne(
    { customer_id: String(customerId) },
    { $set: { facts, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
}

module.exports = { getCustomerFacts, updateCustomerFacts };
