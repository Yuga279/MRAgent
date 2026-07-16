// Client-side identity: a durable customerId (localStorage) that survives
// reloads so the server can keep a cross-call customer profile, plus fresh
// per-call session ids for the server's conversation-thread checkpoints.

const CUSTOMER_ID_KEY = "mragentCustomerId";

export function makeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function getCustomerId() {
  try {
    let id = localStorage.getItem(CUSTOMER_ID_KEY);
    if (!id) {
      id = makeId();
      localStorage.setItem(CUSTOMER_ID_KEY, id);
    }
    return id;
  } catch {
    return makeId(); // localStorage blocked → fall back to per-load identity
  }
}
