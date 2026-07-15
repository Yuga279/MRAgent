// Helpers for the free (browser) voice engine: Web Speech API wrappers.

export function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  return Boolean(getSpeechRecognition()) && "speechSynthesis" in window;
}

let cachedVoice = null;

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.name === "Google US English") ||
    voices.find((v) => v.lang === "en-US" && /natural/i.test(v.name)) ||
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang?.startsWith("en")) ||
    null
  );
}

// Voices load asynchronously in Chrome; refresh the cache when they arrive.
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = pickVoice();
  };
}

export function speak(text, { onDone } = {}) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (!cachedVoice) cachedVoice = pickVoice();
  if (cachedVoice) utterance.voice = cachedVoice;
  utterance.rate = 1.05;
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      onDone?.();
    }
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
  return utterance;
}

export function stopSpeaking() {
  window.speechSynthesis.cancel();
}
