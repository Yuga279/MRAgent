// Support-agent domain logic shared by the Deepgram voice agent relay and the
// free-mode /api/chat endpoint: order lookup/placement with consent guards,
// product catalog, function schemas, and the system prompt. Orders and
// products live in MongoDB; the knowledge base lives in Pinecone.
const { searchKnowledge } = require("./rag.js");
const { getOrdersCollection, getProductsCollection } = require("./db.js");

async function getOrderStatus(orderId) {
  const id = String(orderId).trim();
  try {
    const order = await (await getOrdersCollection()).findOne(
      { order_id: id },
      { projection: { _id: 0 } }
    );
    return order
      ? { found: true, ...order }
      : {
          found: false,
          message: `No order found with ID ${orderId}. Ask the customer to double-check the order number.`,
        };
  } catch (error) {
    console.error("Order lookup error:", error);
    return { found: false, message: "The order system is temporarily unavailable." };
  }
}

async function getProductDetails(productName) {
  const name = String(productName || "").trim();
  if (!name) return { found: false, message: "No product name given." };
  try {
    const product = await (await getProductsCollection()).findOne(
      { name: { $regex: escapeRegex(name), $options: "i" } },
      { projection: { _id: 0 } }
    );
    return product
      ? { found: true, ...product }
      : { found: false, message: `No product named "${name}" in the catalog.` };
  } catch (error) {
    console.error("Product lookup error:", error);
    return { found: false, message: "The product catalog is temporarily unavailable." };
  }
}

// The LLM alone proved too eager (it placed orders on garbled inputs like
// "response"), so the server independently checks the customer's actual last
// message before writing an order. Checked in strict order: refusals and
// questions always lose, then affirmations win, then a product mention counts
// as an elliptical yes ("the HomeCam then").
const REFUSAL_PATTERN =
  /\b(no|nope|nah|don'?t|do not|not|never|cancel|stop|wait|hold on|nevermind|never mind|think about it|later|wrong)\b/i;

const QUESTION_PATTERN =
  /\?|^\s*(how|what|why|when|where|which|who|is|are|was|does|do you|can you tell|tell me about)\b/i;

const AFFIRMATION_PATTERN =
  /\b(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|go ahead|proceed|place (the |my |that )?order|order (it|one|that)|buy|purchase|i('|a)?ll take|i want (it|one|to buy)|that one|sounds good|correct|right|please do|do it)\b/i;

const DUPLICATE_ORDER_WINDOW_MS = 3 * 60 * 1000;

// Words too generic to count as naming the product ("the HomeCam 360" → "the").
const PRODUCT_STOPWORDS = new Set(["the", "a", "an", "one", "new", "smart"]);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

async function placeOrder(product, shipping, context = {}) {
  if (!product || typeof product !== "string") {
    return { success: false, message: "No product specified. Ask the customer which product they want." };
  }

  // Gate 1: the model must explicitly assert the customer confirmed.
  if (context.confirmed !== true) {
    return {
      success: false,
      needs_confirmation: true,
      message: `Order NOT placed. First ask the customer to confirm they want to buy the ${product}, then call place_order again with customer_confirmed=true.`,
    };
  }

  // Gate 2: the customer's actual last words must read like consent.
  if (!looksLikePurchaseConsent(context.lastUserMessage, product)) {
    return {
      success: false,
      needs_confirmation: true,
      message: `Order NOT placed — the customer's last message ("${context.lastUserMessage}") is not a clear confirmation. Ask them to clearly confirm the purchase.`,
    };
  }

  const duplicateResult = (existing) => ({
    success: false,
    duplicate: true,
    order_id: existing.order_id,
    message: `Order NOT placed — order ${existing.order_id} for the same product was created moments ago. Tell the customer their existing order number ${existing.order_id}; if they want an additional unit, apologize and ask them to order it again in a few minutes or via the support email.`,
  });
  const buildOrder = (nextId) => {
    const shipDays = shipping === "express" ? 1 : 3;
    return {
      order_id: nextId,
      status: "processing",
      items: [product],
      shipping: shipping === "express" ? "express" : "standard",
      estimated_ship_date: new Date(Date.now() + shipDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      created_at: new Date().toISOString(),
    };
  };

  try {
    const collection = await getOrdersCollection();

    // Gate 3: don't silently create back-to-back duplicates of the same product.
    const cutoff = new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS).toISOString();
    const duplicate = await collection.findOne({
      created_at: { $gt: cutoff },
      items: [product],
    });
    if (duplicate) return duplicateResult(duplicate);

    const [top] = await collection
      .aggregate([
        { $addFields: { idNum: { $convert: { input: "$order_id", to: "int", onError: 0 } } } },
        { $sort: { idNum: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    const order = buildOrder(String(Math.max(top?.idNum || 0, 1000) + 1));
    await collection.insertOne({ ...order });
    return { success: true, ...order };
  } catch (error) {
    console.error("Place order error:", error);
    return { success: false, message: "The order system is temporarily unavailable." };
  }
}

// Handlers receive (args, context) where context.lastUserMessage is the
// customer's most recent utterance — used for server-side consent checks.
const FUNCTION_HANDLERS = {
  search_knowledge: async (args) => {
    try {
      return await searchKnowledge(args.query);
    } catch (error) {
      console.error("Knowledge search error:", error);
      return { found: false, message: "The knowledge base is temporarily unavailable." };
    }
  },
  get_order_status: (args) => getOrderStatus(args.order_id),
  get_product_details: (args) => getProductDetails(args.product),
  place_order: (args, context = {}) =>
    placeOrder(args.product, args.shipping, {
      confirmed: args.customer_confirmed === true,
      lastUserMessage: context.lastUserMessage,
    }),
};

const SEARCH_KNOWLEDGE_FUNCTION = {
  name: "search_knowledge",
  description:
    "Search the company knowledge base (shipping, returns, warranty, products, prices, hours, contact info). Call this BEFORE answering any question about company policies or products.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look up, e.g. 'express shipping cost' or 'HomeCam 360 price'",
      },
    },
    required: ["query"],
  },
};

const SUPPORT_FUNCTIONS = [
  SEARCH_KNOWLEDGE_FUNCTION,
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
  {
    name: "get_product_details",
    description:
      "Look up a catalog product's exact price and description by name. Use it to answer product questions and to verify the product name before placing an order.",
    parameters: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description: "Product name (or part of it), e.g. HomeCam 360",
        },
      },
      required: ["product"],
    },
  },
  {
    name: "place_order",
    description:
      "Place a new order for a catalog product. Call ONLY after the customer has explicitly said yes to buying this exact product — never call it for unclear, garbled, or meta questions. Returns the new order number.",
    parameters: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description: "Exact product name from the catalog, e.g. HomeCam 360",
        },
        shipping: {
          type: "string",
          enum: ["standard", "express"],
          description: "Shipping method the customer chose (default standard)",
        },
        customer_confirmed: {
          type: "boolean",
          description:
            "true ONLY if the customer's most recent message explicitly confirms they want to buy this product. Never guess or assume.",
        },
      },
      required: ["product", "customer_confirmed"],
    },
  },
];

// Knowledge (Pinecone) reaches the model two ways:
//  - retrievedKnowledge given → RAG: the caller already queried Pinecone with
//    the customer's question; the top chunks are inlined (used by /api/chat).
//  - no retrievedKnowledge → the search_knowledge function does retrieval per
//    question (used by the Deepgram agent, whose prompt is fixed once at
//    session start).
// pastMemories: relevant exchanges from previous calls, recalled from the
// Pinecone memory namespace (long-term memory across sessions).
function buildSupportPrompt({ retrievedKnowledge, pastMemories } = {}) {
  const retrieved = retrievedKnowledge != null;
  const knowledgeRule = retrieved
    ? "3. Answer ONLY from the knowledge base, this conversation, the past conversations section (if present), and your functions. If you don't know, say so in one sentence and offer the support email."
    : "3. Answer ONLY from search_knowledge results, this conversation, the past conversations section (if present), and your other functions. For ANY question about products, prices, shipping, returns, warranty, or company info, call search_knowledge first. If it returns nothing, say you don't know in one sentence and offer the support email.";
  return [
    retrieved
      ? "You are a friendly customer support agent for the company described in the knowledge base below, speaking with a customer over the phone."
      : "You are a friendly customer support agent for Acme Gadgets, speaking with a customer over the phone. Company information comes from the search_knowledge function.",
    "RULES — follow every one:",
    "1. Reply in ONE short sentence of plain spoken English, 20 words or fewer. Never use lists, headings, or long explanations.",
    "2. Give only what was asked. The customer will follow up if they want more.",
    knowledgeRule,
    "4. For order status questions, ask for the order number and use get_order_status.",
    "5. Ordering protocol, in strict sequence: (a) the customer names a product, (b) you ask them to confirm that product and choose standard or express shipping, (c) ONLY when their next message clearly says yes do you call place_order — then tell them just the order number and ship date. Never invent order numbers or tracking details, and never place the same order twice.",
    "6. This is a voice call, so messages may arrive garbled or cut off (e.g. 'response', 'don't you have'). If a message is unclear or doesn't make sense, ask the customer to repeat it — NEVER call a function or take an action based on an unclear message.",
    // Wording matters here: earlier phrasing that mentioned "function-call
    // syntax" taught Llama to emit literal <function=...> text, which Groq
    // rejects with tool_use_failed.
    "7. Never mention functions, tools, or JSON to the customer. Use the tools API to call functions; your text reply must contain only plain spoken English.",
    ...(retrieved
      ? ["", "=== KNOWLEDGE BASE (most relevant entries for this customer's question) ===", retrievedKnowledge]
      : []),
    ...(pastMemories
      ? [
          "",
          "=== PAST CONVERSATIONS (your own memory of this customer's earlier calls) ===",
          "You DO have this information — if the answer is below, give it directly instead of saying you don't know. Never invent details beyond what is written here.",
          pastMemories,
        ]
      : []),
  ].join("\n");
}

// Some models (notably Llama) occasionally leak tool-call markup into their
// text reply — strip it so it is never spoken to the customer.
function sanitizeReply(text) {
  return (text || "")
    .replace(/<function[\s\S]*?<\/function>/gi, "")
    .replace(/<function=[^>]*>?/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

module.exports = {
  getOrderStatus,
  getProductDetails,
  placeOrder,
  looksLikePurchaseConsent,
  FUNCTION_HANDLERS,
  SUPPORT_FUNCTIONS,
  buildSupportPrompt,
  sanitizeReply,
};
