# Real-time voice agent (React + Node + Deepgram)

A real-time voice app with two modes:

- **Support Agent** — talk naturally with an AI customer-support agent. It answers from your company data and can look up orders mid-conversation.
- **Transcribe** — live speech-to-text of your microphone, with a "Listen" button that reads the transcript back.

Both tabs work with either of two **voice engines**, switchable in ⚙️ Settings (persisted in the browser):

| | Deepgram engine | Browser (free) engine |
|---|---|---|
| Speech-to-text | Deepgram nova-3 (streamed via WebSocket relay) | Web Speech API in Chrome/Edge |
| Agent brain | gpt-4o-mini via Deepgram Voice Agent API | Groq (Llama 3.3 70B) or Gemini 2.5 Flash via `POST /api/chat` |
| Text-to-speech | Deepgram Aura (natural voices, barge-in) | Browser `speechSynthesis` voices |
| Cost | Deepgram usage | $0 (free LLM tiers) |
| Keys needed | `DEEPGRAM_API_KEY` | `GROQ_API_KEY` and/or `GEMINI_API_KEY` |

In free mode **nothing touches Deepgram** — audio stays in the browser and only conversation text reaches the server. Both engines share the same knowledge base and order-lookup function calling.

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
2. Set the keys for the engine(s) you use — `DEEPGRAM_API_KEY` for Deepgram mode,
   `GROQ_API_KEY` (console.groq.com) and/or `GEMINI_API_KEY` (aistudio.google.com)
   for the free browser mode. Any missing engine is disabled gracefully.

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
