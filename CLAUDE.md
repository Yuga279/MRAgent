# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Real-time voice app (live transcription + conversational voice agent) split into two sibling packages:

- [server/](server/) — Express + `ws` backend ([server/server.js](server/server.js)) with three surfaces:
  - `/ws` — relay to Deepgram live transcription (`client.listen.v1.connect`, `nova-3`).
  - `/ws-agent` — customer-support agent relay to the Deepgram Voice Agent API (`wss://agent.deepgram.com/v1/agent/converse`, via raw `ws`, NOT the SDK — the SDK's agent socket JSON-parses every frame and breaks on binary agent audio). `buildAgentSettings()` sends the `Settings` message on open (linear16 @ 24kHz both directions, nova-3 listen, `open_ai`/`gpt-4o-mini` think, `aura-2-thalia-en` speak) with [server/data/knowledge.md](server/data/knowledge.md) injected into the prompt, then pipes binary audio and JSON events both ways. The relay intercepts `FunctionCallRequest` frames and executes handlers from `FUNCTION_HANDLERS` server-side (`get_order_status` reads [server/data/orders.json](server/data/orders.json)), replying with `FunctionCallResponse`; all frames are still forwarded to the browser. Text frames from the browser (e.g. `InjectUserMessage`) pass through to Deepgram — useful for testing without a mic.
  - `POST /api/tts` — Deepgram Aura TTS (`client.speak.v1.audio.generate`) returning MP3; text is split into ≤1900-char sentence chunks and concatenated (Deepgram caps TTS at 2000 chars/request).
  - `POST /api/chat` — LLM chat for the free (browser) voice engine; no Deepgram involved. Same support prompt (`buildSupportPrompt()`) and tools (`SUPPORT_FUNCTIONS`) as the Deepgram agent, with server-side function-call loops for both Groq (`llama-3.3-70b-versatile`, OpenAI-compatible `tool_calls`) and Gemini (`gemini-2.5-flash`, `functionDeclarations`/`functionResponse`). Provider chosen by request body `provider` field, falling back to whichever of `GROQ_API_KEY`/`GEMINI_API_KEY` is set.

  `DEEPGRAM_API_KEY` is optional at startup — without it the Deepgram surfaces return errors but `/api/chat` still works.

  Serves the built React app from `client/dist` at http://localhost:3000 (port via `PORT`). Loads `server/.env` via `dotenv`. Also contains a separate batch transcription CLI ([server/src/transcribe.js](server/src/transcribe.js), exports `transcribeFile`) which does not load `.env`.
- [client/](client/) — Vite + React frontend. [App.jsx](client/src/App.jsx) has a ⚙️ Settings panel choosing the voice engine (`deepgram` | `browser`, persisted in localStorage as `voiceEngine`; free-mode LLM as `llmProvider`) and renders two tabs, each with a per-engine implementation:
  - Browser (free) engine — no Deepgram traffic at all: [BrowserAgentPanel.jsx](client/src/BrowserAgentPanel.jsx) (Web Speech `SpeechRecognition` → `POST /api/chat` → `speechSynthesis`; the mic is paused while the agent speaks to avoid transcribing its own voice, so no barge-in) and [BrowserTranscribePanel.jsx](client/src/BrowserTranscribePanel.jsx), sharing [speech.js](client/src/speech.js) (voice picking, Chrome auto-restart of recognition). Chrome/Edge only.
  - Deepgram engine tabs:
  - [AgentPanel.jsx](client/src/AgentPanel.jsx) — conversational agent. ScriptProcessor captures mic as 16-bit PCM @ 24kHz (must match the server's agent `Settings` sample rates), agent audio chunks are scheduled gap-free via Web Audio `AudioBufferSource`s, `UserStartedSpeaking` triggers barge-in by stopping queued sources. Conversation log from `ConversationText` events.
  - [TranscribePanel.jsx](client/src/TranscribePanel.jsx) — live transcription (MediaRecorder 250ms chunks over `/ws`, interim vs final via `message.is_final`) plus a "Listen" button that posts the transcript to `/api/tts` and plays the MP3.

There is no linter or test suite.

## Commands

Requires Node ≥18 (machine default may be 14 via nvm4w — run `nvm use 22.17.0` first).

```bash
# Install (each package separately)
cd server && npm install
cd client && npm install

# Development: backend on :3000, Vite dev server on :5173 proxying /ws, /ws-agent, /api to it
cd server && npm start        # terminal 1
cd client && npm run dev      # terminal 2 (HMR)

# Production: build the client, then the server serves it on :3000
cd client && npm run build
cd server && npm start

# Batch transcription (defaults to server/sample.wav)
cd server && npm run transcribe -- path/to/audio.wav
```

Do NOT use `npm --prefix <dir> install` from outside a package — it has erroneously added the outer package as a `file:..` dependency. Run npm from inside `client/` or `server/`.

## Setup

`DEEPGRAM_API_KEY` is read from `server/.env` (loaded by `server.js` via dotenv, explicit path so cwd doesn't matter) or the environment — copy [server/.env.example](server/.env.example) to `server/.env`.

## Architecture notes

- Both WebSocket servers use `noServer: true` with manual routing in a single `server.on("upgrade")` handler — two path-scoped `WebSocket.Server`s attached to one HTTP server each 400 the other's upgrade requests.
- Relays queue browser messages until the upstream Deepgram connection opens, then flush.
- End-to-end testing without a microphone: drive headless Chrome (puppeteer-core) with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>` against a server on a spare port.
