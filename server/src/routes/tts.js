// POST /api/tts — Deepgram Aura TTS returning MP3. Deepgram caps text at
// 2000 characters per request, so long transcripts are split on sentence
// boundaries and the MP3 chunks concatenated.
const express = require("express");
const { DeepgramClient } = require("@deepgram/sdk");

const config = require("../config.js");
const { chunkBySentence } = require("../utils/text.js");

const TTS_CHUNK_LIMIT = 1900;
const TTS_MODEL = "aura-2-thalia-en";

const router = express.Router();

router.post("/api/tts", async (req, res) => {
  if (!config.deepgramApiKey) {
    return res.status(400).json({ error: "DEEPGRAM_API_KEY not configured" });
  }
  const text = (req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "No text provided" });
  }

  try {
    const client = new DeepgramClient({ apiKey: config.deepgramApiKey });
    const buffers = [];
    for (const chunk of chunkBySentence(text, TTS_CHUNK_LIMIT)) {
      const audio = await client.speak.v1.audio.generate({
        text: chunk,
        model: TTS_MODEL,
      });
      buffers.push(Buffer.from(await audio.arrayBuffer()));
    }
    res.set("Content-Type", "audio/mpeg").send(Buffer.concat(buffers));
  } catch (error) {
    console.error("TTS error:", error);
    res.status(502).json({ error: error.message || "TTS request failed" });
  }
});

module.exports = router;
