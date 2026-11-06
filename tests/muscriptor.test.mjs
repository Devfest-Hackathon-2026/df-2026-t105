import test from "node:test";
import assert from "node:assert/strict";
import { muscriptorNotes, muscriptorInstruments } from "../src/core/muscriptor.js";
import { parseTranscription } from "../server/transcription.mjs";

test("MuScriptor pairs events by index and discards invalid notes", () => {
  const events = [
    { type: "start", index: 3, instrument: "flutes", pitch: 64, start_time: 1 },
    { type: "start", index: 2, instrument: "electric_bass", pitch: 60, start_time: 0 },
    { type: "end", start_event_index: 3, end_time: 2 },
    { type: "end", start_event_index: 99, end_time: 4 },
    { type: "end", start_event_index: 2, end_time: 0.5 },
    { type: "end", start_event_index: 3, end_time: -1 },
  ];
  assert.deepEqual(muscriptorNotes(events), [{ pitch: 60, start: 0, end: 0.5, instrument: "electric_bass" }, { pitch: 64, start: 1, end: 2, instrument: "flutes" }]);
});
test("MuScriptor chooses the requested instrument for each track", () => {
  for (const [target, text, expected] of [["drums", "dry kit", "drums"], ["bass", "upright bass", "acoustic_bass"], ["bass", "synth bass", "electric_bass"], ["lead", "solo dry flute", "flutes"], ["lead", "marimba", "chromatic_percussion"], ["lead", "square-wave synth", "synth_lead"]]) {
    assert.deepEqual(muscriptorInstruments(target, [{ text }]), [expected]);
  }
});
test("MuScriptor SSE handles CRLF and rejects errors and incomplete streams", () => {
  const note = { type: "start", index: 0, pitch: 60, start_time: 0 };
  assert.deepEqual(parseTranscription(`: ping\r\ndata: {"type":"progress"}\r\ndata:${JSON.stringify(note)}\r\ndata: {"type":"transcription_complete"}\r\n`), [note]);
  assert.throws(() => parseTranscription('data: {"type":"error","message":"CUDA failed"}\n'), /CUDA failed/);
  assert.throws(() => parseTranscription(`data: ${JSON.stringify(note)}\n`), /before completion/);
});
