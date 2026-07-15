# Real-time voice agent (React + Node + Deepgram)

A real-time voice app with two modes:

- **Support Agent** — talk naturally with an AI customer-support agent (Deepgram Voice Agent API: speech-to-text → LLM → text-to-speech, with barge-in support). It answers from your company data and can look up orders mid-conversation. The browser streams your mic to the Node backend, which relays to Deepgram; the agent's voice and the conversation text stream back live.
- **Transcribe** — live speech-to-text of your microphone, with a "Listen" button that reads the transcript back using Deepgram TTS.

```
client/   React + Vite frontend
server/   Express + ws backend (Deepgram relay), batch transcribe CLI
```

## Using your own data

The support agent's knowledge lives in [server/data/](server/data/):

- `knowledge.md` — your company info, policies, products, FAQ. Injected into the
  agent's prompt at the start of every conversation; edit freely (no restart needed).
- `orders.json` — backs the `get_order_status` function the agent calls when a
  customer asks about an order. Replace with your real order source (swap the
  file read in `getOrderStatus()` in [server/server.js](server/server.js) for a
  database or API call).

The agent's persona, greeting, voice, and LLM are configured in
`buildAgentSettings()` in [server/server.js](server/server.js).

## Installation

Requires Node ≥ 18.

```bash
cd server && npm install
cd ../client && npm install
```

## Setup

1. Copy [server/.env.example](server/.env.example) to `server/.env`.
2. Set your Deepgram API key in `server/.env` (loaded automatically by the server).

```bash
copy server\.env.example server\.env
```

## Usage

### Development (with hot reload)

```bash
# Terminal 1 — backend
cd server
npm start

# Terminal 2 — frontend (Vite dev server)
cd client
npm run dev
```

Open http://localhost:5173, click **Start Listening**, and speak.

### Production

```bash
cd client && npm run build
cd ../server && npm start
```

Open http://localhost:3000.

### Batch transcription of a local file

```bash
cd server
npm run transcribe -- path/to/audio.wav
```
