# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Real-time voice transcription app split into two sibling packages:

- [server/](server/) — Express + `ws` backend ([server/server.js](server/server.js)). WebSocket relay mounted at `/ws`: browser audio → Deepgram live transcription (`client.listen.v1.connect`, `nova-3` model) → results back to the browser. Also `POST /api/tts` — Deepgram Aura TTS (`client.speak.v1.audio.generate`, `aura-2-thalia-en`) returning MP3; long text is split into ≤1900-char sentence chunks and the MP3 buffers concatenated (Deepgram caps TTS at 2000 chars/request). Serves the built React app from `client/dist` at http://localhost:3000 (port via `PORT`). Loads `server/.env` via `dotenv`. Also contains a separate batch transcription CLI ([server/src/transcribe.js](server/src/transcribe.js), exports `transcribeFile`) which does not load `.env`.
- [client/](client/) — Vite + React frontend. All UI logic is in [client/src/App.jsx](client/src/App.jsx): MediaRecorder captures mic audio in 250ms chunks, sends binary over WebSocket, renders interim results (italic/gray) and final lines separately. A "Listen" button posts the final transcript to `/api/tts` and plays the returned MP3.
There is no linter or test suite.

## Commands

Requires Node ≥18 (machine default may be 14 via nvm4w — run `nvm use 22.17.0` first).

```bash
# Install (each package separately)
cd server && npm install
cd client && npm install

# Development: backend on :3000, Vite dev server on :5173 proxying /ws to it
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

- The backend queues incoming audio messages until the Deepgram connection opens, then flushes ([server/server.js:58](server/server.js#L58)).
- The frontend distinguishes interim vs final transcripts via `message.is_final` on Deepgram `Results` messages; interim text is replaced in place, finals are appended.
- The WebSocket URL `ws://<host>/ws` and `/api/*` work in both modes: Vite proxies them to :3000 (see [client/vite.config.js](client/vite.config.js)); in production the same origin serves both.
