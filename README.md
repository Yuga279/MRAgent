# Real-time voice agent (React + Node + Deepgram)

A real-time voice app with two modes:

- **Voice Agent** — talk naturally with an AI agent (Deepgram Voice Agent API: speech-to-text → LLM → text-to-speech, with barge-in support). The browser streams your mic to the Node backend, which relays to Deepgram; the agent's voice and the conversation text stream back live.
- **Transcribe** — live speech-to-text of your microphone, with a "Listen" button that reads the transcript back using Deepgram TTS.

```
client/   React + Vite frontend
server/   Express + ws backend (Deepgram relay), batch transcribe CLI
```

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
