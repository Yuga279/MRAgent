const fs = require("fs");
const path = require("path");
const { DeepgramClient } = require("@deepgram/sdk");

async function transcribeFile(filePath) {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    throw new Error("Set DEEPGRAM_API_KEY before running this script.");
  }

  const client = new DeepgramClient({ apiKey });
  const stream = fs.createReadStream(filePath);

  const response = await client.listen.v1.media.transcribeFile(stream, {
    model: "nova-3",
  });

  return response.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

async function main() {
  const targetPath = process.argv[2] ?? path.join(__dirname, "..", "sample.wav");

  if (!fs.existsSync(targetPath)) {
    console.error(`Audio file not found: ${targetPath}`);
    process.exitCode = 1;
    return;
  }

  try {
    const transcript = await transcribeFile(targetPath);
    console.log(transcript);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { transcribeFile };
