// Product catalog lookups against the MongoDB `products` collection.
const { getProductsCollection } = require("../infra/db.js");
const { escapeRegex } = require("../utils/text.js");

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

module.exports = { getProductDetails };
