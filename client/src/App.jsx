import { useEffect, useState } from "react";
import TranscribePanel from "./TranscribePanel.jsx";
import AgentPanel from "./AgentPanel.jsx";
import BrowserAgentPanel from "./BrowserAgentPanel.jsx";
import BrowserTranscribePanel from "./BrowserTranscribePanel.jsx";

export default function App() {
  const [tab, setTab] = useState("agent");
  const [showSettings, setShowSettings] = useState(false);
  const [engine, setEngine] = useState(() => localStorage.getItem("voiceEngine") || "deepgram");
  const [provider, setProvider] = useState(() => localStorage.getItem("llmProvider") || "groq");

  useEffect(() => {
    localStorage.setItem("voiceEngine", engine);
  }, [engine]);

  useEffect(() => {
    localStorage.setItem("llmProvider", provider);
  }, [provider]);

  const isFree = engine === "browser";

  return (
    <div className="container">
      <div className="header-row">
        <div>
          <h1>🎧 Customer Support Agent</h1>
          <p className="subtitle">
            {isFree
              ? "Free browser mode — Web Speech + " + (provider === "gemini" ? "Gemini" : "Groq")
              : "Natural voice support, powered by Deepgram"}
          </p>
        </div>
        <button
          className="settings-btn"
          onClick={() => setShowSettings((v) => !v)}
          title="Settings"
        >
          ⚙️ Settings
        </button>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <div className="settings-group">
            <div className="settings-label">Voice engine</div>
            <label>
              <input
                type="radio"
                name="engine"
                checked={engine === "deepgram"}
                onChange={() => setEngine("deepgram")}
              />
              Deepgram — natural voices, best accuracy (uses your Deepgram API key)
            </label>
            <label>
              <input
                type="radio"
                name="engine"
                checked={engine === "browser"}
                onChange={() => setEngine("browser")}
              />
              Browser (free) — Web Speech API, no Deepgram usage at all
            </label>
          </div>

          {isFree && (
            <div className="settings-group">
              <div className="settings-label">LLM provider (free mode)</div>
              <label>
                <input
                  type="radio"
                  name="provider"
                  checked={provider === "groq"}
                  onChange={() => setProvider("groq")}
                />
                Groq (Llama 3.3 70B) — needs GROQ_API_KEY in server/.env
              </label>
              <label>
                <input
                  type="radio"
                  name="provider"
                  checked={provider === "gemini"}
                  onChange={() => setProvider("gemini")}
                />
                Google Gemini (2.5 Flash) — needs GEMINI_API_KEY in server/.env
              </label>
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        <button className={tab === "agent" ? "active" : ""} onClick={() => setTab("agent")}>
          Support Agent
        </button>
        <button
          className={tab === "transcribe" ? "active" : ""}
          onClick={() => setTab("transcribe")}
        >
          Transcribe
        </button>
      </div>

      {tab === "agent" ? (
        isFree ? (
          <BrowserAgentPanel provider={provider} />
        ) : (
          <AgentPanel />
        )
      ) : isFree ? (
        <BrowserTranscribePanel />
      ) : (
        <TranscribePanel />
      )}
    </div>
  );
}
