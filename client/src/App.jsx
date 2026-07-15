import { useState } from "react";
import TranscribePanel from "./TranscribePanel.jsx";
import AgentPanel from "./AgentPanel.jsx";

export default function App() {
  const [tab, setTab] = useState("agent");

  return (
    <div className="container">
      <h1>🎙️ Voice Agent</h1>
      <p className="subtitle">Powered by Deepgram</p>

      <div className="tabs">
        <button className={tab === "agent" ? "active" : ""} onClick={() => setTab("agent")}>
          Voice Agent
        </button>
        <button
          className={tab === "transcribe" ? "active" : ""}
          onClick={() => setTab("transcribe")}
        >
          Transcribe
        </button>
      </div>

      {tab === "agent" ? <AgentPanel /> : <TranscribePanel />}
    </div>
  );
}
