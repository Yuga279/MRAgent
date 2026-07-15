import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechRecognition, speechSupported, speak, stopSpeaking } from "./speech.js";

// Free-mode transcription: Web Speech API in the browser, no server involved.
export default function BrowserTranscribePanel() {
  const [status, setStatus] = useState("idle"); // idle | listening | stopped | error
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [finalLines, setFinalLines] = useState([]);
  const [interimText, setInterimText] = useState("");
  const [speaking, setSpeaking] = useState(false);

  const recognitionRef = useRef(null);
  const activeRef = useRef(false);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [finalLines, interimText]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {
        // not started
      }
      recognitionRef.current = null;
    }
    setInterimText("");
    setStatus("stopped");
    setStatusMessage("Stopped");
  }, []);

  useEffect(
    () => () => {
      stop();
      stopSpeaking();
    },
    [stop]
  );

  const start = useCallback(() => {
    setFinalLines([]);
    setInterimText("");
    setStatus("listening");
    setStatusMessage("Listening…");
    activeRef.current = true;

    const Recognition = getSpeechRecognition();
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) setFinalLines((lines) => [...lines, text]);
        } else {
          interim += result[0].transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setStatus("error");
      setStatusMessage(
        event.error === "not-allowed"
          ? "Microphone access denied — allow the mic and try again."
          : `Speech recognition error: ${event.error}`
      );
    };

    recognition.onend = () => {
      if (activeRef.current) {
        try {
          recognition.start();
        } catch {
          // already restarted
        }
      }
    };

    recognition.start();
  }, []);

  const listen = useCallback(() => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    const text = finalLines.join(" ").trim();
    if (!text) return;
    setSpeaking(true);
    speak(text, { onDone: () => setSpeaking(false) });
  }, [finalLines, speaking]);

  if (!speechSupported()) {
    return (
      <p className="placeholder">
        This browser doesn't support the Web Speech API. Use Chrome or Edge for the free voice
        mode, or switch back to Deepgram in Settings.
      </p>
    );
  }

  const isActive = status === "listening";

  return (
    <>
      <div className="control-panel">
        <button className="start" onClick={start} disabled={isActive}>
          Start Listening
        </button>
        <button className="stop" onClick={stop} disabled={!isActive}>
          Stop
        </button>
        <button className="listen" onClick={listen} disabled={finalLines.length === 0}>
          {speaking ? "⏹ Stop Playback" : "🔊 Listen"}
        </button>
        <span className={`status status-${status}`}>{statusMessage}</span>
      </div>

      <div className="transcript">
        {finalLines.length === 0 && !interimText && (
          <p className="placeholder">Transcript will appear here…</p>
        )}
        {finalLines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
        {interimText && <p className="interim">{interimText}</p>}
        <div ref={transcriptEndRef} />
      </div>
    </>
  );
}
