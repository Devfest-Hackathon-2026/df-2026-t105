/** Pair complete, valid note events. Unmatched or malformed events cannot form a note. */
export function muscriptorNotes(events) {
  const starts = new Map(events.filter((e) => e.type === "start" && Number.isInteger(e.index)).map((e) => [e.index, e]));
  return events.filter((e) => e.type === "end").flatMap((e) => {
    const s = starts.get(e.start_event_index);
    if (!s || !Number.isInteger(s.pitch) || s.pitch < 0 || s.pitch > 127 || !Number.isFinite(s.start_time) || s.start_time < 0 || !Number.isFinite(e.end_time) || e.end_time <= s.start_time) return [];
    return [{ pitch: s.pitch, start: s.start_time, end: e.end_time, instrument: typeof s.instrument === "string" ? s.instrument : "unknown" }];
  }).sort((a, b) => a.start - b.start);
}

/** Restrict a solo transcription to the instrument Lyria was asked to play. */
export function muscriptorInstruments(target, prompts) {
  const text = prompts.map((p) => p.text).join(" ").toLowerCase();
  if (target === "drums") return ["drums"];
  if (target === "bass") return [/upright|double bass|acoustic bass/.test(text) ? "acoustic_bass" : "electric_bass"];
  if (/marimba|vibraphone|xylophone/.test(text)) return ["chromatic_percussion"];
  if (/flute|ocarina|whistl/.test(text)) return ["flutes"];
  return ["synth_lead"];
}
