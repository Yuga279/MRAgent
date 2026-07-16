// Self-reflection guard for factual accuracy: after the agent drafts a reply,
// a cheap verifier model checks every factual claim against the retrieved
// knowledge chunks; unsupported claims trigger ONE correction round. This
// catches the classic support-bot failure — confidently invented prices,
// policies, and timelines — that the tool-boundary guards (orders.js) cannot,
// because it lives in the reply text, not in an action.
//
// Fail-open by design: if the verifier errors or returns garbage, the draft
// reply ships as-is. Blocking the customer on a broken verifier would be a
// worse failure than an unverified answer.
const { SystemMessage, HumanMessage } = require("@langchain/core/messages");

const { buildChatModel, contentToText } = require("../llm/providers.js");

// retrieveKnowledge() signals "nothing retrieved" with parenthesized
// placeholder strings — there is nothing to verify against in that case.
function hasVerifiableKnowledge(retrievedKnowledge) {
  return Boolean(retrievedKnowledge) && !/^\(/.test(retrievedKnowledge.trim());
}

// Pull the first JSON object out of a model reply that may be wrapped in
// code fences or prose.
function parseVerdict(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.supported !== "boolean") return null;
    return { supported: parsed.supported, issues: String(parsed.issues || "") };
  } catch {
    return null;
  }
}

// Check the draft reply against the knowledge excerpts. Returns
// { supported, issues }; errors resolve to supported (fail open).
async function verifyReply({ reply, retrievedKnowledge, provider }) {
  const prompt = [
    "You are a strict fact-checker for a phone support agent. Decide whether the agent's reply contains factual claims NOT supported by the knowledge excerpts below.",
    "Rules:",
    "- Only company facts need support: prices, fees, policies, timelines, product specs, contact info, hours.",
    "- Order numbers, ship dates, order statuses, and product availability come from the live order system, NOT the excerpts — always treat them as supported.",
    "- Greetings, confirmations, questions back to the customer, and offers to help contain no claims — always supported.",
    '- Output ONLY JSON: {"supported": true} or {"supported": false, "issues": "<one short sentence naming each unsupported claim>"}',
    "",
    "=== KNOWLEDGE EXCERPTS ===",
    retrievedKnowledge,
    "",
    "=== AGENT REPLY TO CHECK ===",
    reply,
  ].join("\n");

  try {
    const result = await buildChatModel(provider, "extractor").invoke(prompt);
    return parseVerdict(contentToText(result.content)) || { supported: true, issues: "" };
  } catch (error) {
    console.error("Reply verification error:", error);
    return { supported: true, issues: "" };
  }
}

// One correction round: regenerate the reply with the verifier's findings,
// using the raw chat model (no tools — corrections are about wording facts
// right, not taking new actions) and WITHOUT touching the conversation
// checkpoint, so the thread never sees the internal back-and-forth.
async function correctReply({ draft, issues, systemPrompt, lastUserMessage, provider }) {
  try {
    const result = await buildChatModel(provider, "chat").invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(lastUserMessage),
      new HumanMessage(
        [
          "[INTERNAL FACT-CHECK — the customer never sees this message]",
          `Your draft reply was: ${JSON.stringify(draft)}`,
          `Problem: ${issues}`,
          "Rewrite the reply, keeping your warm phone tone, using ONLY facts from the knowledge base above. If the knowledge base doesn't cover it, say you don't know in one sentence and offer the support email. Output only the corrected reply.",
        ].join("\n")
      ),
    ]);
    return contentToText(result.content).trim() || draft;
  } catch (error) {
    console.error("Reply correction error:", error);
    return draft; // fail open — ship the draft rather than nothing
  }
}

module.exports = { hasVerifiableKnowledge, verifyReply, correctReply, parseVerdict };
