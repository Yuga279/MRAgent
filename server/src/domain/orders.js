// Order lookup and placement against the MongoDB `orders` collection.
// place_order is the only irreversible action in the system, so it sits
// behind three server-side gates (see placeOrder).
const { getOrdersCollection } = require("../infra/db.js");
const { looksLikePurchaseConsent } = require("./consent.js");

const DUPLICATE_ORDER_WINDOW_MS = 3 * 60 * 1000;

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

module.exports = { getOrderStatus, placeOrder };
