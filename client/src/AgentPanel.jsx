import { useCallback, useEffect, useRef, useState } from "react";

// Must match audio.input/output sample_rate in the server's agent Settings.
const SAMPLE_RATE = 24000;

export default function AgentPanel() {
  const [status, setStatus] = useState("idle"); // idle | connecting | active | stopped | error
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [agentState, setAgentState] = useState(""); // Listening… | Thinking… | Speaking…
  const [messages, setMessages] = useState([]);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const scheduledSourcesRef = useRef(new Set());
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentState]);

  const stopAgentAudio = useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    scheduledSourcesRef.current.clear();
    nextPlayTimeRef.current = 0;
  }, []);

  const cleanup = useCallback(() => {
    stopAgentAudio();

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    }
    wsRef.current = null;
  }, [stopAgentAudio]);

  useEffect(() => cleanup, [cleanup]);

  const playAgentChunk = useCallback((arrayBuffer) => {
    const ctx = audioCtxRef.current;
    if (!ctx || arrayBuffer.byteLength < 2) return;

    const pcm = new Int16Array(arrayBuffer);
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      floats[i] = pcm[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, floats.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(floats);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + buffer.duration;

    scheduledSourcesRef.current.add(source);
    source.onended = () => scheduledSourcesRef.current.delete(source);
  }, []);

  const handleAgentEvent = useCallback(
    (message) => {
      switch (message.type) {
        case "Welcome":
          setStatus("active");
          setStatusMessage("Connected");
          setAgentState("Listening…");
          break;
        case "ConversationText":
          setMessages((prev) => [...prev, { role: message.role, content: message.content }]);
          break;
        case "UserStartedSpeaking":
          // Barge-in: drop any queued agent audio so the user can interrupt.
          stopAgentAudio();
          setAgentState("Listening…");
          break;
        case "AgentThinking":
          setAgentState("Thinking…");
          break;
        case "FunctionCallRequest":
          setAgentState("Looking that up…");
          break;
        case "AgentStartedSpeaking":
          setAgentState("Speaking…");
          break;
        case "AgentAudioDone":
          setAgentState("Listening…");
          break;
        case "Error":
          setStatus("error");
          setStatusMessage(message.description || "Agent error");
          break;
        default:
          break;
      }
    },
    [stopAgentAudio]
  );

  const start = useCallback(async () => {
    setStatus("connecting");
    setStatusMessage("Requesting microphone…");
    setMessages([]);
    setAgentState("");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      setStatus("error");
      setStatusMessage(`Microphone access denied: ${error.message}`);
      return;
    }
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = ctx;
    nextPlayTimeRef.current = 0;

    setStatusMessage("Connecting to agent…");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws-agent`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          handleAgentEvent(JSON.parse(event.data));
        } catch {
          // ignore malformed frames
        }
      } else {
        playAgentChunk(event.data);
      }
    };

    ws.onopen = () => {
      // Stream raw 16-bit PCM to the relay; the agent expects linear16.
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      sourceRef.current = source;
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const sample = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        ws.send(pcm.buffer);
      };

      source.connect(processor);
      processor.connect(ctx.destination);
    };

    ws.onerror = () => {
      setStatus("error");
      setStatusMessage("WebSocket connection failed");
      cleanup();
    };

    ws.onclose = () => {
      setStatus((current) => (current === "error" ? current : "stopped"));
      setStatusMessage("Disconnected");
      setAgentState("");
      cleanup();
    };
  }, [cleanup, handleAgentEvent, playAgentChunk]);

  const stop = useCallback(() => {
    cleanup();
    setStatus("stopped");
    setStatusMessage("Conversation ended");
    setAgentState("");
  }, [cleanup]);

  const isActive = status === "connecting" || status === "active";

  return (
    <>
      <div className="control-panel">
        <button className="start" onClick={start} disabled={isActive}>
          Start Conversation
        </button>
        <button className="stop" onClick={stop} disabled={!isActive}>
          End
        </button>
        <span className={`status status-${status === "active" ? "listening" : status}`}>
          {statusMessage}
          {agentState && ` — ${agentState}`}
        </span>
      </div>

      <div className="chat">
        {messages.length === 0 && (
          <p className="placeholder">
            Start a conversation and talk to the support agent — it answers from the company
            knowledge base and can look up orders.
          </p>
        )}
        {messages.map((message, i) => (
          <div key={i} className={`bubble ${message.role === "user" ? "user" : "assistant"}`}>
            {message.content}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
    </>
  );
}
