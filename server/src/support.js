// Support-agent domain logic shared by the Deepgram voice agent relay and the
// free-mode /api/chat endpoint: knowledge base, order lookup/placement with
// consent guards, function schemas, and the system prompt.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.MRAGENT_DATA_DIR || path.join(__dirname, "..", "data");

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
      return {
        found: false,
        message: `No order found with ID ${orderId}. Ask the customer to double-check the order number.`,
      };
    }
    return { found: true, ...order };
  } catch (error) {
    console.error("Order lookup error:", error);
    return { found: false, message: "The order system is temporarily unavailable." };
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

function placeOrder(product, shipping, context = {}) {
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

  try {
    const ordersPath = path.join(DATA_DIR, "orders.json");
    const orders = JSON.parse(fs.readFileSync(ordersPath, "utf8"));

    // Gate 3: don't silently create back-to-back duplicates of the same product.
    const duplicate = orders.find(
      (o) =>
        o.created_at &&
        Date.now() - Date.parse(o.created_at) < DUPLICATE_ORDER_WINDOW_MS &&
        (o.items || []).join() === product
    );
    if (duplicate) {
      return {
        success: false,
        duplicate: true,
        order_id: duplicate.order_id,
        message: `Order NOT placed — order ${duplicate.order_id} for the same product was created moments ago. Tell the customer their existing order number ${duplicate.order_id}; if they want an additional unit, apologize and ask them to order it again in a few minutes or via the support email.`,
      };
    }

    const nextId = String(
      orders.reduce((max, o) => Math.max(max, Number(o.order_id) || 0), 1000) + 1
    );
    const shipDays = shipping === "express" ? 1 : 3;
    const shipDate = new Date(Date.now() + shipDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const order = {
      order_id: nextId,
      status: "processing",
      items: [product],
      shipping: shipping === "express" ? "express" : "standard",
      estimated_ship_date: shipDate,
      created_at: new Date().toISOString(),
    };
    orders.push(order);
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2) + "\n");
    return { success: true, ...order };
  } catch (error) {
    console.error("Place order error:", error);
    return { success: false, message: "The order system is temporarily unavailable." };
  }
}

// Handlers receive (args, context) where context.lastUserMessage is the
// customer's most recent utterance — used for server-side consent checks.
const FUNCTION_HANDLERS = {
  get_order_status: (args) => getOrderStatus(args.order_id),
  place_order: (args, context = {}) =>
    placeOrder(args.product, args.shipping, {
      confirmed: args.customer_confirmed === true,
      lastUserMessage: context.lastUserMessage,
    }),
};

const SUPPORT_FUNCTIONS = [
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

function buildSupportPrompt() {
  return [
    "You are a friendly customer support agent for the company described in the knowledge base below, speaking with a customer over the phone.",
    "RULES — follow every one:",
    "1. Reply in ONE short sentence of plain spoken English, 20 words or fewer. Never use lists, headings, or long explanations.",
    "2. Give only what was asked. The customer will follow up if they want more.",
    "3. Answer ONLY from the knowledge base and your functions. If you don't know, say so in one sentence and offer the support email.",
    "4. For order status questions, ask for the order number and use get_order_status.",
    "5. Ordering protocol, in strict sequence: (a) the customer names a product, (b) you ask them to confirm that product and choose standard or express shipping, (c) ONLY when their next message clearly says yes do you call place_order — then tell them just the order number and ship date. Never invent order numbers or tracking details, and never place the same order twice.",
    "6. This is a voice call, so messages may arrive garbled or cut off (e.g. 'response', 'don't you have'). If a message is unclear or doesn't make sense, ask the customer to repeat it — NEVER call a function or take an action based on an unclear message.",
    "7. Never mention functions, tools, or JSON, and never write function-call syntax in your reply — functions are called silently through the API.",
    "",
    "=== KNOWLEDGE BASE ===",
    loadKnowledge(),
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
  DATA_DIR,
  loadKnowledge,
  getOrderStatus,
  placeOrder,
  looksLikePurchaseConsent,
  FUNCTION_HANDLERS,
  SUPPORT_FUNCTIONS,
  buildSupportPrompt,
  sanitizeReply,
};
