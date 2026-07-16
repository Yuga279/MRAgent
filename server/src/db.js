// MongoDB access for orders, product catalog, and LangGraph conversational
// memory. Configured via MONGODB_URI (+ optional MONGODB_DB, default
// "mragent"); when unset, callers fall back to the JSON-file data in
// server/data. The mongodb package is required lazily so the server still
// boots without it when Mongo is not configured.
const DB_NAME = process.env.MONGODB_DB || "mragent";

let clientPromise = null;

function isMongoConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

async function getClient() {
  if (!isMongoConfigured()) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb() {
  return (await getClient()).db(DB_NAME);
}

async function getOrdersCollection() {
  return (await getDb()).collection("orders");
}

async function getProductsCollection() {
  return (await getDb()).collection("products");
}

async function closeDb() {
  if (clientPromise) {
    const client = await clientPromise;
    clientPromise = null;
    await client.close();
  }
}

module.exports = {
  DB_NAME,
  isMongoConfigured,
  getClient,
  getDb,
  getOrdersCollection,
  getProductsCollection,
  closeDb,
};
