# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Real-time voice app (live transcription + conversational voice agent) split into two sibling packages:

- [server/](server/) — Express + `ws` backend. [server/server.js](server/server.js) is a thin composition root; everything lives in layered modules under `server/src/`:
  - `config.js` — loads `server/.env` (explicit path so cwd doesn't matter) and exposes all env values; nothing else reads `process.env`.
  - `utils/text.js` — `escapeRegex`, `chunkBySentence`.
  - `domain/` — business logic, unit-testable without the server: `consent.js` (`looksLikePurchaseConsent` + refusal/question/affirmation patterns), `orders.js` (`getOrderStatus`, `placeOrder` with the three consent gates), `products.js`, `prompt.js` (`buildSupportPrompt`, `sanitizeReply`), `functions.js` (`FUNCTION_HANDLERS`, `FUNCTION_DOCS`, `SUPPORT_FUNCTIONS` schemas — shared by both voice modes).
  - `infra/` — external systems: `db.js` (MongoDB collections), `rag.js` (Pinecone knowledge + exchange memory).
  - `llm/providers.js` — the ONLY place chat models are constructed: `buildChatModel(provider, role)` (role `chat` | `extractor`), `resolveProvider`, `contentToText`. Add a provider or change a model id here.
  - `agent/` — `agentGraph.js` (LangGraph ReAct agent for /api/chat), `tools.js` (LangChain wrappers over the domain handlers), `memory.js` (customer profile).
  - `routes/` — express Routers: `tts.js`, `chat.js`. `ws/` — `index.js` (upgrade routing) + `transcribeRelay.js` (/ws) + `agentRelay.js` (/ws-agent).

  The four surfaces:
  - `/ws` — relay to Deepgram live transcription (`client.listen.v1.connect`, `nova-3`) in [ws/transcribeRelay.js](server/src/ws/transcribeRelay.js).
  - `/ws-agent` — customer-support agent relay ([ws/agentRelay.js](server/src/ws/agentRelay.js)) to the Deepgram Voice Agent API (`wss://agent.deepgram.com/v1/agent/converse`, via raw `ws`, NOT the SDK — the SDK's agent socket JSON-parses every frame and breaks on binary agent audio). `buildAgentSettings()` sends the `Settings` message on open (linear16 @ 24kHz both directions, nova-3 listen, `open_ai`/`gpt-4o-mini` think, `aura-2-thalia-en` speak) then pipes binary audio and JSON events both ways. The relay intercepts `FunctionCallRequest` frames and executes handlers from `FUNCTION_HANDLERS` server-side (orders/products in MongoDB, knowledge via the `search_knowledge` function → Pinecone), replying with `FunctionCallResponse`; all frames are still forwarded to the browser. Text frames from the browser (e.g. `InjectUserMessage`) pass through to Deepgram — useful for testing without a mic.
  - `POST /api/tts` ([routes/tts.js](server/src/routes/tts.js)) — Deepgram Aura TTS returning MP3; text is split into ≤1900-char sentence chunks and concatenated (Deepgram caps TTS at 2000 chars/request).
  - `POST /api/chat` ([routes/chat.js](server/src/routes/chat.js)) — LLM chat for the free (browser) voice engine; no Deepgram involved. Backed by a LangGraph ReAct agent ([server/src/agent/agentGraph.js](server/src/agent/agentGraph.js), `createReactAgent` from `@langchain/langgraph/prebuilt`) with `ChatGroq` (`llama-3.3-70b-versatile`) or `ChatGoogleGenerativeAI` (`gemini-2.5-flash`) — the LangChain adapters handle each provider's tool-call wire format. Tools are built per request (`buildTools(context)`) so handlers get `lastUserMessage` for the consent guard. Knowledge is retrieve-then-generate: `retrieveKnowledge()` queries Pinecone with the customer's question and the chunks are injected into the prompt — the chat LLM does NOT get a `search_knowledge` tool, because Llama on Groq deterministically emits the call as literal `<function=...>` text (Groq 400s with `tool_use_failed`; there's a one-retry guard for stragglers). Provider chosen by request body `provider` field, falling back to whichever of `GROQ_API_KEY`/`GEMINI_API_KEY` is set. After the graph returns, a self-reflection guard ([agent/verify.js](server/src/agent/verify.js)) fact-checks the draft reply against the retrieved chunks with the cheap extractor model and allows ONE correction round (raw chat model, no tools, checkpoint untouched so the thread never sees the internal back-and-forth). It fails open — verifier errors/garbage ship the draft — and is skipped when retrieval returned only a placeholder. Deliberately NOT a LangGraph postModelHook: in the JS prebuilt a hook-appended message routes to END instead of back to the agent, and hook messages would be persisted into the MongoDB thread.

  `DEEPGRAM_API_KEY` is optional at startup — without it the Deepgram surfaces return errors but `/api/chat` still works.

  Serves the built React app from `client/dist` at http://localhost:3000 (port via `PORT`). Also contains a separate batch transcription CLI ([server/src/transcribe.js](server/src/transcribe.js), exports `transcribeFile`) which does not load `.env`.

  `place_order` ([domain/orders.js](server/src/domain/orders.js)) has three server-side guards (LLMs proved too eager, placing orders on garbled voice input): the model must pass `customer_confirmed=true`, the customer's actual last utterance must match an affirmation pattern (`looksLikePurchaseConsent` in [domain/consent.js](server/src/domain/consent.js) — a shipping choice like "express" counts as consent since it answers the agent's confirm question; refusals and questions are checked first and win), and back-to-back duplicates of the same product within 3 minutes are rejected. Both function-call paths (the LangGraph tools in agent/tools.js and the Deepgram relay's `handleFunctionCallRequest`) thread `context.lastUserMessage` into handlers — the relay tracks it from user `ConversationText` events.
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

All configuration is read from `server/.env` (loaded by [server/src/config.js](server/src/config.js) via dotenv, explicit path so cwd doesn't matter) or the environment — copy [server/.env.example](server/.env.example) to `server/.env`.

### MongoDB: orders, products, conversational memory (required)

`MONGODB_URI` is required for the support agent's data ([server/src/infra/db.js](server/src/infra/db.js), db name `MONGODB_DB` default `mragent`; the mongodb package is required lazily). `get_order_status`/`place_order` read/write the `orders` collection (all three consent gates preserved; the duplicate check queries `created_at` ISO strings; next order id via `$convert`-on-`order_id` aggregation, starting at 1001 on an empty collection); `get_product_details` reads the `products` collection (name/price/description — currently unseeded, so product prices come from Pinecone knowledge instead). `/api/chat` keeps conversational memory as LangGraph checkpoints (`MongoDBSaver`, `checkpoints`/`checkpoint_writes` collections) keyed by the browser-generated `sessionId` (new UUID per call in BrowserAgentPanel); with a sessionId only the newest user message is fed to the graph and the client-sent history is ignored. There are no JSON-file fallbacks anymore (orders.json was removed); without Mongo, handlers return "temporarily unavailable".

Mongo also holds the durable per-customer profile ([server/src/agent/memory.js](server/src/agent/memory.js), `customer_memory` collection): the browser keeps a persistent `customerId` in localStorage (`mragentCustomerId` — distinct from the per-call `sessionId` thread id, both in [client/src/identity.js](client/src/identity.js)) and sends it with each `/api/chat` request; `getCustomerFacts` injects the customer's fact list into the prompt as a CUSTOMER PROFILE section (`buildSupportPrompt({customerFacts})`), and after each helpful reply `updateCustomerFacts` runs fire-and-forget: a cheap extraction call (Groq `llama-3.1-8b-instant` / Gemini flash) is given the existing facts plus the new exchange and rewrites the full ≤12-fact list (add/update/drop in one pass; unparseable output leaves the old profile untouched).

### Long-term memory: Pinecone `memory` namespace

Cross-session conversational memory lives in the same Pinecone index, namespace `memory` (`saveMemory`/`recallMemories` in [server/src/infra/rag.js](server/src/infra/rag.js); records `{_id: mem-<sessionId>-<ts>, chunk_text: "Customer: …\nAgent: …", session_id, saved_at}`). On every `/api/chat` turn the agent recalls top-3 past exchanges relevant to the question (min score 0.25, across ALL sessions — there is no per-customer identity) and injects them into the prompt as a PAST CONVERSATIONS section; after replying it saves the exchange fire-and-forget. Two hard-won details: "I don't know"-style replies are NOT saved (they outscore useful memories on similar questions and teach the model to keep failing), and the section wording must insist "You DO have this information" — with tools bound, Llama otherwise refuses to answer from memory even when the answer is right there (the same prompt without tools answers fine). Pinecone serverless indexing lags ~10–30s, so a memory saved seconds ago may not recall yet. `DEBUG_PROMPT=1` logs the full system prompt per request. MongoDB checkpoints remain the short-term within-session memory.

### Knowledge base: Pinecone RAG (required)

The knowledge base lives in a Pinecone vector index ([server/src/infra/rag.js](server/src/infra/rag.js), REST API with Pinecone integrated embeddings `llama-text-embed-v2` — no separate embedding key needed; `PINECONE_API_KEY`, index `mragent-knowledge` overridable via `PINECONE_INDEX`). Knowledge reaches the model two ways (`buildSupportPrompt({retrievedKnowledge})`): `/api/chat` retrieves top-3 chunks up front and injects them; the Deepgram agent gets a `search_knowledge` function in `SUPPORT_FUNCTIONS` since its prompt is fixed at session start. Ingest/re-ingest after editing [server/data/knowledge.md](server/data/knowledge.md) with `cd server && npm run ingest-knowledge` (chunks by `##` section, auto-creates the index). Function handlers are async — the agent relay's `handleFunctionCallRequest` `await`s them.

## Architecture notes

- Both WebSocket servers use `noServer: true` with manual routing in a single `server.on("upgrade")` handler — two path-scoped `WebSocket.Server`s attached to one HTTP server each 400 the other's upgrade requests.
- Relays queue browser messages until the upstream Deepgram connection opens, then flush.
- End-to-end testing without a microphone: drive headless Chrome (puppeteer-core) with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>` against a server on a spare port.
