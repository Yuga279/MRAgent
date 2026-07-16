// /ws — relay browser mic audio to Deepgram live transcription and stream
// transcript events back. Messages are queued until the upstream Deepgram
// connection opens, then flushed.
const WebSocket = require("ws");
const { DeepgramClient } = require("@deepgram/sdk");

const config = require("../config.js");

async function handleTranscribeConnection(ws) {
  console.log("Client connected");

  if (!config.deepgramApiKey) {
    ws.send(JSON.stringify({ type: "error", message: "DEEPGRAM_API_KEY not configured" }));
    ws.close();
    return;
  }

  let connection = null;
  let isConnected = false;
  const messageQueue = [];

  try {
    const client = new DeepgramClient({ apiKey: config.deepgramApiKey });

    connection = await client.listen.v1.connect({
      model: "nova-3",
      language: "en",
      punctuate: true,
      interim_results: true,
    });

    connection.on("open", () => {
      console.log("Deepgram connection opened");
      isConnected = true;
      ws.send(JSON.stringify({ type: "status", message: "Connected" }));

      while (messageQueue.length > 0) {
        const data = messageQueue.shift();
        try {
          if (connection.socket) {
            connection.socket.send(data);
          }
        } catch (error) {
          console.error("Error flushing queued message:", error);
        }
      }
    });

    connection.on("message", (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });

    connection.on("error", (error) => {
      console.error("Deepgram error:", error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: error.message }));
      }
    });

    connection.on("close", () => {
      console.log("Deepgram connection closed");
      isConnected = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    ws.on("message", (data) => {
      try {
        if (isConnected && connection && connection.socket) {
          connection.socket.send(data);
        } else if (!isConnected) {
          messageQueue.push(data);
        }
      } catch (error) {
        console.error("Error sending to Deepgram:", error);
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
      if (connection && connection.socket) {
        try {
          connection.socket.close();
        } catch (e) {
          console.error("Error closing connection:", e);
        }
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    await connection.connect();
  } catch (error) {
    console.error("Connection error:", error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: error.message }));
      ws.close();
    }
  }
}

module.exports = { handleTranscribeConnection };
