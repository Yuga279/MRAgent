import { useCallback, useEffect, useRef, useState } from "react";

const CHUNK_INTERVAL_MS = 250;

export default function TranscribePanel() {
  const [status, setStatus] = useState("idle"); // idle | connecting | listening | stopped | error
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [finalLines, setFinalLines] = useState([]);
  const [interimText, setInterimText] = useState("");

  const [playback, setPlayback] = useState("idle"); // idle | loading | playing

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const audioRef = useRef(null);

  const cleanup = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    }
    wsRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [finalLines, interimText]);

  const handleServerMessage = useCallback((event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "status") {
      setStatus("listening");
      setStatusMessage("Listening…");
      return;
    }

    if (message.type === "error") {
      setStatus("error");
      setStatusMessage(message.message || "Server error");
      return;
    }

    if (message.type === "Results") {
      const transcript = message.channel?.alternatives?.[0]?.transcript ?? "";
      if (!transcript) return;

      if (message.is_final) {
        setFinalLines((lines) => [...lines, transcript]);
        setInterimText("");
      } else {
        setInterimText(transcript);
      }
    }
  }, []);

  const start = useCallback(async () => {
    setStatus("connecting");
    setStatusMessage("Requesting microphone…");
    setFinalLines([]);
    setInterimText("");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setStatus("error");
      setStatusMessage(`Microphone access denied: ${error.message}`);
      return;
    }
    streamRef.current = stream;

    setStatusMessage("Connecting to server…");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = handleServerMessage;

    ws.onopen = () => {
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      };
      mediaRecorder.start(CHUNK_INTERVAL_MS);
    };

    ws.onerror = () => {
      setStatus("error");
      setStatusMessage("WebSocket connection failed");
      cleanup();
    };

    ws.onclose = () => {
      setStatus((current) => (current === "error" ? current : "stopped"));
      setStatusMessage((current) =>
        current.startsWith("Microphone") || current.includes("failed") ? current : "Disconnected"
      );
      cleanup();
    };
  }, [cleanup, handleServerMessage]);

  const stop = useCallback(() => {
    cleanup();
    setStatus("stopped");
    setStatusMessage("Stopped");
  }, [cleanup]);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setPlayback("idle");
  }, []);

  const listen = useCallback(async () => {
    if (playback === "playing" || playback === "loading") {
      stopPlayback();
      return;
    }

    const text = finalLines.join(" ").trim();
    if (!text) return;

    setPlayback("loading");
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `TTS request failed (${response.status})`);
      }

      const blob = await response.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = stopPlayback;
      audio.onerror = stopPlayback;
      await audio.play();
      setPlayback("playing");
    } catch (error) {
      stopPlayback();
      setStatusMessage(`Playback failed: ${error.message}`);
    }
  }, [finalLines, playback, stopPlayback]);

  const isActive = status === "connecting" || status === "listening";

  return (
    <>
      <div className="control-panel">
        <button className="start" onClick={start} disabled={isActive}>
          Start Listening
        </button>
        <button className="stop" onClick={stop} disabled={!isActive}>
          Stop
        </button>
        <button
          className="listen"
          onClick={listen}
          disabled={playback === "loading" || finalLines.length === 0}
        >
          {playback === "loading"
            ? "Loading…"
            : playback === "playing"
              ? "⏹ Stop Playback"
              : "🔊 Listen"}
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
