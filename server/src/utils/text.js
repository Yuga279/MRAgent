// Small shared text helpers with no domain knowledge.

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split text into chunks of at most `limit` characters on sentence
// boundaries (used for TTS, which caps characters per request).
function chunkBySentence(text, limit) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      chunks.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

module.exports = { escapeRegex, chunkBySentence };
