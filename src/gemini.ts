import type { LyriaSpec, Note, Project, TrackId } from "./state";
import { describeTrack } from "./state";

const MODEL = "gemini-flash-latest";

async function callJson<T>(apiKey: string, prompt: string, schema: object): Promise<T> {
  // キーがあれば直接呼ぶ。なければ同じオリジンの中継サーバー（server/index.mjs）を通す
  const url = apiKey
    ? `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
    : `${location.origin}/api/gemini/${MODEL}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "x-goog-api-key": apiKey } : {}) },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingLevel: "low" } },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return JSON.parse(text) as T;
}

const SPEC_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    prompts: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { text: { type: "STRING" }, weight: { type: "NUMBER" } }, required: ["text", "weight"] },
    },
    density: { type: "NUMBER" },
    brightness: { type: "NUMBER" },
    guidance: { type: "NUMBER" },
    rationale: { type: "STRING" },
  },
  required: ["title", "prompts", "density", "brightness", "guidance", "rationale"],
};

/**
 * 「こうしたい」という言葉と今の曲の中身から、Lyria に渡す指示を2案作る。
 * 2案は、意図の解釈が違うもの（例: 音域を上げて目立たせる案と、音数を減らして寄り添う案）にする。
 * 同じ意図でも解釈が複数あることを利用者に見せ、どちらを採るかを利用者に決めてもらうため。
 */
export async function intentToSpecs(apiKey: string, p: Project, target: TrackId, intent: string, count: 1 | 2 = 1): Promise<LyriaSpec[]> {
  const role = target === "bass" ? "bassline" : target === "drums" ? "drum pattern" : "lead melody";
  const instrumentRules =
    target === "drums"
      ? `- Use only a dry drum kit with kick, snare and closed hi-hat (no cymbal crashes, toms, percussion or reverb), because only these three are transcribed.
- Always include "dry drum kit, kick, snare, closed hi-hat" in the first prompt. Do not mention bass or any pitched instrument in the prompts (they leak into the kick band and break the transcription).`
      : `- Pick ONE instrument from this list (they transcribe reliably): ${target === "bass" ? '"synth bass", "electric bass (fingered)", "upright bass"' : '"square-wave synth lead", "flute", "whistling", "ocarina", "marimba"'}. Never guitar, piano, clarinet, strings, pads or choirs (they are hard to transcribe). Candidates may use different instruments.
- Always include the words "solo", "monophonic", "dry" in the first prompt. No chords, no reverb.`;
  const prompt = `You help a beginner music producer. They are writing a ${p.bars}-bar loop at ${p.bpm} BPM in ${p.root} major / its relative minor.
Current tracks (MIDI, 16th-note steps):
${(Object.keys(p.tracks) as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}

They want a suggestion for the ${role}. Their intent (may be Japanese): """${intent}"""

Lyria RealTime will generate audio for ONLY this part, which will then be transcribed to MIDI.
${count === 1 ? "Return exactly ONE candidate that fits the intent." : "Return exactly TWO candidates with different interpretations of the intent (register, rhythm density, contour)."}
For each candidate:
${instrumentRules}
- Describe the musical character that serves the intent and fits the other tracks (rhythm, register, contour, energy).
- 1 to 3 weighted prompts, short English phrases.
- density 0..1 (how busy), brightness 0..1, guidance 3..5.
- title: a short Japanese label (max 16 chars) that names the interpretation, e.g. "高音で歌い上げる".
- rationale: one short Japanese sentence explaining how this phrase fits the intent. No introduction.`;
  const r = await callJson<{ candidates: LyriaSpec[] }>(apiKey, prompt, {
    type: "OBJECT",
    properties: { candidates: { type: "ARRAY", items: SPEC_SCHEMA } },
    required: ["candidates"],
  });
  if (!r.candidates?.length) throw new Error("Gemini が候補を返しませんでした");
  return r.candidates.slice(0, count);
}

/** 採用候補のゴーストノートについて、どんなフレーズなのかを初心者向けに説明する */
export async function explainGhost(apiKey: string, p: Project, target: TrackId, ghost: Note[], intent: string): Promise<string> {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const drum: Record<number, string> = { 36: "kick", 38: "snare", 42: "hat" };
  const g = target === "drums"
    ? ghost.map((x) => `${x.step}:${drum[x.pitch] ?? x.pitch}`).join(" ")
    : ghost.map((x) => `${x.step}:${names[x.pitch % 12]}${Math.floor(x.pitch / 12) - 1}x${x.len}`).join(" ");
  const prompt = `A beginner asked for: """${intent}""". Key ${p.root} major/relative minor, ${p.bpm} BPM, ${p.bars} bars of 16 steps.
Existing tracks:
${(Object.keys(p.tracks) as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}
Proposed ${target} notes (step:pitch x length): ${g}

In Japanese, 3 short bullet points: (1) the shape of this phrase (rhythm, contour, repetition), (2) ${target === "drums" ? "how it locks with the existing bassline rhythm (which bass notes share a step with the kick)" : "how it relates to the existing bass/chords (which notes are chord tones, any tension)"}, (3) one concrete thing the user could change by hand to push it further toward their intent. Only state what you can see from the note data; do not invent.`;
  const r = await callJson<{ bullets: string[] }>(apiKey, prompt, {
    type: "OBJECT",
    properties: { bullets: { type: "ARRAY", items: { type: "STRING" } } },
    required: ["bullets"],
  });
  return r.bullets.map((b) => "・" + b.replace(/^[・\-\s]+/, "")).join("\n");
}
