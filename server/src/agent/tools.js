// LangChain tool wrappers around the shared domain function handlers, for the
// LangGraph chat agent. Built per request so they close over the conversation
// context (lastUserMessage drives the server-side purchase-consent guard).
// search_knowledge is deliberately NOT exposed here: Llama on Groq emits the
// call as literal <function=...> text, so the chat path retrieves knowledge
// up front instead (see agentGraph.js).
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

const { FUNCTION_HANDLERS, FUNCTION_DOCS } = require("../domain/functions.js");

function buildTools(context) {
  const wrap = (result) => JSON.stringify(result);

  return [
    tool(
      async ({ order_id }) => wrap(await FUNCTION_HANDLERS.get_order_status({ order_id }, context)),
      {
        name: "get_order_status",
        description: FUNCTION_DOCS.get_order_status,
        schema: z.object({
          order_id: z.string().describe("The customer's order number, e.g. 1001"),
        }),
      }
    ),
    tool(
      async ({ product }) => wrap(await FUNCTION_HANDLERS.get_product_details({ product }, context)),
      {
        name: "get_product_details",
        description: FUNCTION_DOCS.get_product_details,
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
        description: FUNCTION_DOCS.place_order,
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
}

module.exports = { buildTools };
