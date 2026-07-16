# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Real-time voice app (live transcription + conversational voice agent) split into two sibling packages:

- [server/](server/) — Express + `ws` backend ([server/server.js](server/server.js)) with three surfaces:
  - `/ws` — relay to Deepgram live transcription (`client.listen.v1.connect`, `nova-3`).
  - `/ws-agent` — customer-support agent relay to the Deepgram Voice Agent API (`wss://agent.deepgram.com/v1/agent/converse`, via raw `ws`, NOT the SDK — the SDK's agent socket JSON-parses every frame and breaks on binary agent audio). `buildAgentSettings()` sends the `Settings` message on open (linear16 @ 24kHz both directions, nova-3 listen, `open_ai`/`gpt-4o-mini` think, `aura-2-thalia-en` speak) then pipes binary audio and JSON events both ways. The relay intercepts `FunctionCallRequest` frames and executes handlers from `FUNCTION_HANDLERS` server-side (orders/products in MongoDB, knowledge via the `search_knowledge` function → Pinecone), replying with `FunctionCallResponse`; all frames are still forwarded to the browser. Text frames from the browser (e.g. `InjectUserMessage`) pass through to Deepgram — useful for testing without a mic.
  - `POST /api/tts` — Deepgram Aura TTS (`client.speak.v1.audio.generate`) returning MP3; text is split into ≤1900-char sentence chunks and concatenated (Deepgram caps TTS at 2000 chars/request).
  - `POST /api/chat` — LLM chat for the free (browser) voice engine; no Deepgram involved. Backed by a LangGraph ReAct agent ([server/src/agentGraph.js](server/src/agentGraph.js), `createReactAgent` from `@langchain/langgraph/prebuilt`) with `ChatGroq` (`llama-3.3-70b-versatile`) or `ChatGoogleGenerativeAI` (`gemini-2.5-flash`) — the LangChain adapters handle each provider's tool-call wire format. Tools are built per request (`buildTools(context)`) so handlers get `lastUserMessage` for the consent guard. Knowledge is retrieve-then-generate: `retrieveKnowledge()` queries Pinecone with the customer's question and the chunks are injected into the prompt — the chat LLM does NOT get a `search_knowledge` tool, because Llama on Groq deterministically emits the call as literal `<function=...>` text (Groq 400s with `tool_use_failed`; there's a one-retry guard for stragglers). Provider chosen by request body `provider` field, falling back to whichever of `GROQ_API_KEY`/`GEMINI_API_KEY` is set.

  `DEEPGRAM_API_KEY` is optional at startup — without it the Deepgram surfaces return errors but `/api/chat` still works.

  Serves the built React app from `client/dist` at http://localhost:3000 (port via `PORT`). Loads `server/.env` via `dotenv`. Also contains a separate batch transcription CLI ([server/src/transcribe.js](server/src/transcribe.js), exports `transcribeFile`) which does not load `.env`.

  Support-agent domain logic lives in [server/src/support.js](server/src/support.js) (`get_order_status`/`get_product_details`/`place_order` handlers backed by MongoDB, `search_knowledge` backed by Pinecone, function schemas, prompt, reply sanitizer) so it is unit-testable without starting the server. `place_order` has three server-side guards (LLMs proved too eager, placing orders on garbled voice input): the model must pass `customer_confirmed=true`, the customer's actual last utterance must match an affirmation pattern (`looksLikePurchaseConsent`), and back-to-back duplicates of the same product within 3 minutes are rejected. Both function-call paths (the LangGraph tools in agentGraph.js and the Deepgram relay's `handleFunctionCallRequest`) thread `context.lastUserMessage` into handlers — the relay tracks it from user `ConversationText` events.
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

### MongoDB: orders, products, conversational memory (required)

`MONGODB_URI` is required for the support agent's data ([server/src/db.js](server/src/db.js), db name `MONGODB_DB` default `mragent`; the mongodb package is required lazily). `get_order_status`/`place_order` read/write the `orders` collection (all three consent gates preserved; the duplicate check queries `created_at` ISO strings; next order id via `$convert`-on-`order_id` aggregation, starting at 1001 on an empty collection); `get_product_details` reads the `products` collection (name/price/description — currently unseeded, so product prices come from Pinecone knowledge instead). `/api/chat` keeps conversational memory as LangGraph checkpoints (`MongoDBSaver`, `checkpoints`/`checkpoint_writes` collections) keyed by the browser-generated `sessionId` (new UUID per call in BrowserAgentPanel); with a sessionId only the newest user message is fed to the graph and the client-sent history is ignored. There are no JSON-file fallbacks anymore (orders.json was removed); without Mongo, handlers return "temporarily unavailable".

### Knowledge base: Pinecone RAG (required)

The knowledge base lives in a Pinecone vector index ([server/src/rag.js](server/src/rag.js), REST API with Pinecone integrated embeddings `llama-text-embed-v2` — no separate embedding key needed; `PINECONE_API_KEY`, index `mragent-knowledge` overridable via `PINECONE_INDEX`). Knowledge reaches the model two ways (`buildSupportPrompt({retrievedKnowledge})`): `/api/chat` retrieves top-3 chunks up front and injects them; the Deepgram agent gets a `search_knowledge` function in `SUPPORT_FUNCTIONS` since its prompt is fixed at session start. Ingest/re-ingest after editing [server/data/knowledge.md](server/data/knowledge.md) with `cd server && npm run ingest-knowledge` (chunks by `##` section, auto-creates the index). Function handlers are async — the agent relay's `handleFunctionCallRequest` `await`s them.

## Architecture notes

- Both WebSocket servers use `noServer: true` with manual routing in a single `server.on("upgrade")` handler — two path-scoped `WebSocket.Server`s attached to one HTTP server each 400 the other's upgrade requests.
- Relays queue browser messages until the upstream Deepgram connection opens, then flush.
- End-to-end testing without a microphone: drive headless Chrome (puppeteer-core) with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>` against a server on a spare port.
