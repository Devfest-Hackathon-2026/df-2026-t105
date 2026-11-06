/** MuScriptor returns SSE, including an explicit completion or error event. */
export function parseTranscription(text) {
  const events = [];
  let complete = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const e = JSON.parse(line.slice(5).trimStart());
    if (e.type === "error") throw new Error(e.message || e.error || "MuScriptor transcription failed");
    if (e.type === "start" || e.type === "end") events.push(e);
    if (e.type === "transcription_complete") complete = true;
  }
  if (!complete) throw new Error("MuScriptor stream ended before completion");
  return events;
}
