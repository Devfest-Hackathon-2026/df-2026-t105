/** MuScriptor returns SSE, including an explicit completion or error event. */
export function parseTranscriptionResult(text) {
  const events = [];
  let complete = false, beatGrid = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const e = JSON.parse(line.slice(5).trimStart());
    if (e.type === "error") throw new Error(e.message || e.error || "MuScriptor transcription failed");
    if (e.type === "start" || e.type === "end") events.push(e);
    if (e.type === "transcription_complete") { complete = true; beatGrid = e.beat_grid ?? null; }
  }
  if (!complete) throw new Error("MuScriptor stream ended before completion");
  return { events, beatGrid };
}

export function parseTranscription(text) { return parseTranscriptionResult(text).events; }
