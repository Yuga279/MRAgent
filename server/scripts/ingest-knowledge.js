// One-shot ingestion: chunk server/data/knowledge.md and upsert it into the
// Pinecone index (created automatically if missing). Run after every edit to
// knowledge.md:  cd server && npm run ingest-knowledge
// config.js loads server/.env itself.
const { isPineconeConfigured, ingestKnowledge, INDEX_NAME } = require("../src/infra/rag.js");

async function main() {
  if (!isPineconeConfigured()) {
    console.error("PINECONE_API_KEY is not set. Add it to server/.env and retry.");
    process.exit(1);
  }
  console.log(`Ingesting knowledge.md into Pinecone index "${INDEX_NAME}"...`);
  const chunks = await ingestKnowledge();
  for (const c of chunks) console.log(`  upserted: ${c.section} (${c.text.length} chars)`);
  console.log(`Done — ${chunks.length} chunks upserted.`);
}

main().catch((error) => {
  console.error("Ingestion failed:", error.message);
  process.exit(1);
});
