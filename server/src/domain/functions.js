// The support agent's callable functions: handler implementations plus the
// JSON-schema declarations sent to the Deepgram Voice Agent. The LangGraph
// chat path wraps the same handlers as LangChain tools (agent/tools.js), so
// both voice modes share one set of behaviors and guards.
const { searchKnowledge } = require("../infra/rag.js");
const { getOrderStatus, placeOrder } = require("./orders.js");
const { getProductDetails } = require("./products.js");

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

// Shared parameter documentation so the Deepgram declarations and the
// LangChain tool wrappers describe the functions identically.
const FUNCTION_DOCS = {
  search_knowledge:
    "Search the company knowledge base (shipping, returns, warranty, products, prices, hours, contact info). Call this BEFORE answering any question about company policies or products.",
  get_order_status:
    "Look up the current status of a customer's order (shipping status, tracking number, delivery estimate) by its order number.",
  get_product_details:
    "Look up a catalog product's exact price and description by name. Use it to answer product questions and to verify the product name before placing an order.",
  place_order:
    "Place a new order for a catalog product. Call ONLY after the customer has explicitly said yes to buying this exact product — never call it for unclear, garbled, or meta questions. Returns the new order number.",
};

const SUPPORT_FUNCTIONS = [
  {
    name: "search_knowledge",
    description: FUNCTION_DOCS.search_knowledge,
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
  },
  {
    name: "get_order_status",
    description: FUNCTION_DOCS.get_order_status,
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
    description: FUNCTION_DOCS.get_product_details,
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
    description: FUNCTION_DOCS.place_order,
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

module.exports = { FUNCTION_HANDLERS, FUNCTION_DOCS, SUPPORT_FUNCTIONS };
