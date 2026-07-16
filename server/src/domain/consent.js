// Purchase-consent policy. The LLM alone proved too eager (it placed orders
// on garbled inputs like "response"), so the server independently checks the
// customer's actual last message before writing an order. Checked in strict
// order: refusals and questions always lose, then affirmations win, then a
// product mention counts as an elliptical yes ("the HomeCam then").
const { escapeRegex } = require("../utils/text.js");

const REFUSAL_PATTERN =
  /\b(no|nope|nah|don'?t|do not|not|never|cancel|stop|wait|hold on|nevermind|never mind|think about it|later|wrong)\b/i;

const QUESTION_PATTERN =
  /\?|^\s*(how|what|why|when|where|which|who|is|are|was|does|do you|can you tell|tell me about)\b/i;

// Choosing a shipping method ("express please", "I told you express") is an
// answer to the agent's own confirm-and-choose-shipping question, so it
// counts as consent (refusals and questions are checked first and still win).
const AFFIRMATION_PATTERN =
  /\b(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|go ahead|proceed|place (the |my |that )?order|order (it|one|that)|buy|purchase|i('|a)?ll take|i want (it|one|to buy)|that one|sounds good|correct|right|please do|do it|(express|standard)( shipping)?)\b/i;

// Words too generic to count as naming the product ("the HomeCam 360" → "the").
const PRODUCT_STOPWORDS = new Set(["the", "a", "an", "one", "new", "smart"]);

function looksLikePurchaseConsent(message, product) {
  if (!message || !message.trim()) return false; // no transcript → fail closed
  if (REFUSAL_PATTERN.test(message)) return false;
  if (QUESTION_PATTERN.test(message)) return false;
  if (AFFIRMATION_PATTERN.test(message)) return true;
  const words = String(product || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !PRODUCT_STOPWORDS.has(w));
  return words.some((w) => new RegExp(`\\b${escapeRegex(w)}\\b`, "i").test(message));
}

module.exports = { looksLikePurchaseConsent };
