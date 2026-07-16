// Pinecone-backed knowledge base retrieval. Uses Pinecone's integrated
// embeddings (llama-text-embed-v2) so the only credential needed is
// PINECONE_API_KEY — no separate embedding provider.
//
// Ingest with `npm run ingest-knowledge` (chunks knowledge.md by ## section
// and upserts). At runtime the agent calls search_knowledge, which queries
// the index; when PINECONE_API_KEY is missing the app falls back to inlining
// knowledge.md in the prompt as before.
const fs = require("fs");
const path = require("path");

const PINECONE_API_VERSION = "2025-04";
const EMBED_MODEL = "llama-text-embed-v2";
const NAMESPACE = "knowledge";
// Long-term conversational memory lives in its own namespace of the same
// index: one record per completed exchange, searched semantically on every
// new customer question (MongoDB checkpoints remain the short-term,
// within-session memory).
const MEMORY_NAMESPACE = "memory";

const INDEX_NAME = process.env.PINECONE_INDEX || "mragent-knowledge";
const DATA_DIR = process.env.MRAGENT_DATA_DIR || path.join(__dirname, "..", "data");

function isPineconeConfigured() {
  return Boolean(process.env.PINECONE_API_KEY);
}

function controlHeaders() {
  return {
    "Api-Key": process.env.PINECONE_API_KEY,
    "Content-Type": "application/json",
    "X-Pinecone-API-Version": PINECONE_API_VERSION,
  };
}

// Split knowledge.md into one chunk per "## " section (plus any preamble),
// dropping HTML comments. Sections are small enough to embed whole.
function chunkKnowledge(markdown) {
  const clean = markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
  const chunks = [];
  let section = "General";
  let lines = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) chunks.push({ section, text: `## ${section}\n${text}` });
    lines = [];
  };
  for (const line of clean.split("\n")) {
    const heading = line.match(/^##\s+(.*)/);
    if (heading) {
      flush();
      section = heading[1].trim();
    } else if (!/^#\s/.test(line)) {
      lines.push(line);
    }
  }
  flush();
  return chunks;
}

// The data-plane host is per-index; look it up once and cache it.
let cachedHost = null;

async function getIndexHost() {
  if (cachedHost) return cachedHost;
  const res = await fetch(`https://api.pinecone.io/indexes/${INDEX_NAME}`, {
    headers: controlHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Pinecone describe index failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  cachedHost = (await res.json()).host;
  return cachedHost;
}

async function ensureIndex() {
  if (await getIndexHost()) return cachedHost;
  const res = await fetch("https://api.pinecone.io/indexes/create-for-model", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify({
      name: INDEX_NAME,
      cloud: "aws",
      region: "us-east-1",
      embed: { model: EMBED_MODEL, field_map: { text: "chunk_text" } },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Pinecone create index failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  // Wait until the index reports ready.
  for (let i = 0; i < 30; i++) {
    const describe = await fetch(`https://api.pinecone.io/indexes/${INDEX_NAME}`, {
      headers: controlHeaders(),
    });
    if (describe.ok) {
      const info = await describe.json();
      if (info.status?.ready) {
        cachedHost = info.host;
        return cachedHost;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Pinecone index ${INDEX_NAME} did not become ready in time`);
}

// Data-plane helpers (Pinecone embeds `chunk_text` server-side).
async function upsertRecords(namespace, records) {
  const host = await ensureIndex();
  const res = await fetch(`https://${host}/records/namespaces/${namespace}/upsert`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/x-ndjson",
      "X-Pinecone-API-Version": PINECONE_API_VERSION,
    },
    body: records.map((r) => JSON.stringify(r)).join("\n"),
  });
  if (!res.ok) {
    throw new Error(`Pinecone upsert failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

async function searchRecords(namespace, query, topK, fields) {
  const host = await getIndexHost();
  if (!host) return null; // index not created yet
  const res = await fetch(`https://${host}/records/namespaces/${namespace}/search`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": PINECONE_API_VERSION,
    },
    body: JSON.stringify({
      query: { inputs: { text: String(query || "") }, top_k: topK },
      fields,
    }),
  });
  if (!res.ok) {
    throw new Error(`Pinecone search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).result?.hits || [];
}

// Chunk knowledge.md and upsert every chunk.
async function ingestKnowledge() {
  const markdown = fs.readFileSync(path.join(DATA_DIR, "knowledge.md"), "utf8");
  const chunks = chunkKnowledge(markdown);
  if (chunks.length === 0) throw new Error("knowledge.md produced no chunks");
  await upsertRecords(
    NAMESPACE,
    chunks.map((c, i) => ({ _id: `kb-${i}`, chunk_text: c.text, section: c.section }))
  );
  return chunks;
}

// Semantic search over the knowledge base; returns the matching chunk texts.
async function searchKnowledge(query, topK = 4) {
  if (!isPineconeConfigured()) {
    return { found: false, message: "Knowledge search is not configured." };
  }
  const hits = await searchRecords(NAMESPACE, query, topK, ["chunk_text", "section"]);
  if (hits === null) {
    return { found: false, message: "Knowledge index does not exist yet. Run `npm run ingest-knowledge`." };
  }
  if (hits.length === 0) {
    return { found: false, message: "No matching knowledge base entries." };
  }
  return {
    found: true,
    results: hits.map((h) => ({
      section: h.fields?.section,
      text: h.fields?.chunk_text,
      score: h._score,
    })),
  };
}

// --- Long-term conversational memory ---

// Persist one completed exchange. The id is derived from session + timestamp
// so re-upserts are idempotent per turn.
async function saveMemory({ sessionId, userMessage, agentReply }) {
  if (!isPineconeConfigured()) return;
  const text = `Customer: ${userMessage}\nAgent: ${agentReply}`;
  await upsertRecords(MEMORY_NAMESPACE, [
    {
      _id: `mem-${sessionId}-${Date.now()}`,
      chunk_text: text,
      session_id: String(sessionId || "anonymous"),
      saved_at: new Date().toISOString(),
    },
  ]);
}

// Recall past exchanges (across all sessions) relevant to the new question.
// MIN_SCORE filters out weak matches so unrelated chatter isn't injected.
const MEMORY_MIN_SCORE = 0.25;

async function recallMemories(query, topK = 3) {
  if (!isPineconeConfigured()) return [];
  const hits = (await searchRecords(MEMORY_NAMESPACE, query, topK, [
    "chunk_text",
    "session_id",
    "saved_at",
  ])) || [];
  return hits
    .filter((h) => (h._score ?? 0) >= MEMORY_MIN_SCORE)
    .map((h) => ({
      text: h.fields?.chunk_text,
      sessionId: h.fields?.session_id,
      savedAt: h.fields?.saved_at,
      score: h._score,
    }));
}

module.exports = {
  isPineconeConfigured,
  chunkKnowledge,
  ensureIndex,
  ingestKnowledge,
  searchKnowledge,
  saveMemory,
  recallMemories,
  INDEX_NAME,
};
