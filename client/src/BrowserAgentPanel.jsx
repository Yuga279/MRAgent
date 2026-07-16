import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechRecognition, speechSupported, speak, stopSpeaking } from "./speech.js";

import { getCustomerId, makeId } from "./identity.js";

const GREETING = "Hi! Thanks for calling Acme Gadgets support. How can I help you today?";

// Free-mode support agent: SpeechRecognition (browser STT) → /api/chat
// (Groq/Gemini with the knowledge base) → speechSynthesis (browser TTS).
// The mic is paused while the agent speaks to avoid transcribing its own voice.
export default function BrowserAgentPanel({ provider }) {
  const [status, setStatus] = useState("idle"); // idle | active | stopped | error
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [agentState, setAgentState] = useState("");
  const [messages, setMessages] = useState([]);
  const [interimText, setInterimText] = useState("");

  const recognitionRef = useRef(null);
  const activeRef = useRef(false);
  const busyRef = useRef(false); // true while thinking or speaking
  const messagesRef = useRef([]);
  const providerRef = useRef(provider);
  const sessionIdRef = useRef(null);
  const chatEndRef = useRef(null);

  providerRef.current = provider;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interimText, agentState]);

  const supported = speechSupported();

  const appendMessage = useCallback((message) => {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    busyRef.current = false;
    stopSpeaking();
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      try {
        recognitionRef.current.stop();
      } catch {
        // not started
      }
      recognitionRef.current = null;
    }
    setInterimText("");
    setAgentState("");
    setStatus("stopped");
    setStatusMessage("Conversation ended");
  }, []);

  useEffect(() => () => stop(), [stop]);

  const startListening = useCallback(() => {
    if (!activeRef.current || busyRef.current) return;

    const Recognition = getSpeechRecognition();
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) setInterimText(interim);
      if (finalText.trim()) {
        setInterimText("");
        handleUserTurn(finalText.trim());
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setStatus("error");
      setStatusMessage(
        event.error === "not-allowed"
          ? "Microphone access denied — allow the mic and try again."
          : `Speech recognition error: ${event.error}`
      );
      stop();
    };

    // Chrome stops recognition after a while; restart while the conversation is on.
    recognition.onend = () => {
      if (activeRef.current && !busyRef.current) {
        try {
          recognition.start();
        } catch {
          // already restarted
        }
      }
    };

    recognition.start();
    setAgentState("Listening…");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  const pauseListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {
        // not started
      }
      recognitionRef.current = null;
    }
  }, []);

  const speakReply = useCallback(
    (text) => {
      setAgentState("Speaking…");
      speak(text, {
        onDone: () => {
          busyRef.current = false;
          if (activeRef.current) startListening();
        },
      });
    },
    [startListening]
  );

  const handleUserTurn = useCallback(
    async (text) => {
      busyRef.current = true;
      pauseListening();
      appendMessage({ role: "user", content: text });
      setAgentState("Thinking…");

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: messagesRef.current,
            provider: providerRef.current,
            sessionId: sessionIdRef.current,
            customerId: getCustomerId(),
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || `Chat request failed (${response.status})`);
        }
        appendMessage({ role: "assistant", content: body.reply });
        speakReply(body.reply);
      } catch (error) {
        setStatus("error");
        setStatusMessage(error.message);
        busyRef.current = false;
        if (activeRef.current) startListening();
      }
    },
    [appendMessage, pauseListening, speakReply, startListening]
  );

  const start = useCallback(() => {
    // New thread per call: the server keeps conversational memory (MongoDB
    // LangGraph checkpoints) keyed by this id.
    sessionIdRef.current = makeId();
    messagesRef.current = [{ role: "assistant", content: GREETING }];
    setMessages(messagesRef.current);
    setStatus("active");
    setStatusMessage("Connected (free browser mode)");
    activeRef.current = true;
    busyRef.current = true;
    speakReply(GREETING);
  }, [speakReply]);

  if (!supported) {
    return (
      <p className="placeholder">
        This browser doesn't support the Web Speech API. Use Chrome or Edge for the free voice
        mode, or switch back to Deepgram in Settings.
      </p>
    );
  }

  const isActive = status === "active";

  return (
    <>
      <div className="control-panel">
        <button className="start" onClick={start} disabled={isActive}>
          Start Conversation
        </button>
        <button className="stop" onClick={stop} disabled={!isActive}>
          End
        </button>
        <span className={`status status-${isActive ? "listening" : status}`}>
          {statusMessage}
          {agentState && ` — ${agentState}`}
        </span>
      </div>

      <div className="chat">
        {messages.length === 0 && (
          <p className="placeholder">
            Start a conversation and talk to the support agent — free browser voices, answers from
            the company knowledge base, order lookups included.
          </p>
        )}
        {messages.map((message, i) => (
          <div key={i} className={`bubble ${message.role === "user" ? "user" : "assistant"}`}>
            {message.content}
          </div>
        ))}
        {interimText && <div className="bubble user interim-bubble">{interimText}</div>}
        <div ref={chatEndRef} />
      </div>
    </>
  );
}
