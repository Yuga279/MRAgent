// MongoDB access for orders, product catalog, customer profiles, and
// LangGraph conversational memory. When MONGODB_URI is unset the getters
// throw and callers degrade gracefully. The mongodb package is required
// lazily so the server still boots without it when Mongo is not configured.
const config = require("../config.js");

const DB_NAME = config.mongoDbName;

let clientPromise = null;

function isMongoConfigured() {
  return Boolean(config.mongoUri);
}

async function getClient() {
  if (!isMongoConfigured()) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(config.mongoUri, {
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

async function getCustomerMemoryCollection() {
  return (await getDb()).collection("customer_memory");
}

module.exports = {
  DB_NAME,
  isMongoConfigured,
  getClient,
  getDb,
  getOrdersCollection,
  getProductsCollection,
  getCustomerMemoryCollection,
};
