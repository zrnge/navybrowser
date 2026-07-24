// Offscreen document — runs in a real browser page context so it has access to
// MediaRecorder and AudioContext, which are unavailable in service workers.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.target !== 'offscreen' || msg.type !== 'capture_audio') return false;
  captureAudio(msg.streamId, msg.durationMs)
    .then(b64 => sendResponse({ ok: true, audioB64: b64 }))
    .catch(e  => sendResponse({ ok: false, error: e.message }));
  return true; // keep the message channel open for async response
});

async function captureAudio(streamId, durationMs) {
  if (!durationMs || durationMs < 200) {
    throw new Error(`durationMs must be at least 200ms (got ${durationMs})`);
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  recorder.start(200); // emit chunks every 200ms so we don't lose data on stop
  await new Promise(r => setTimeout(r, durationMs));
  recorder.stop();
  stream.getTracks().forEach(t => t.stop());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("recorder onstop timeout")), 5000);
    recorder.onstop  = () => { clearTimeout(timer); resolve(); };
    recorder.onerror = (e) => { clearTimeout(timer); reject(e.error || new Error("recorder error")); };
  });

  const blob = new Blob(chunks, { type: mimeType });
  return blobToBase64(blob);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
