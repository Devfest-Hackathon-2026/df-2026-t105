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
export async function intentToSpecs(apiKey: string, p: Project, target: TrackId, intent: string): Promise<LyriaSpec[]> {
  const role = target === "bass" ? "bassline" : "lead melody";
  const prompt = `You help a beginner music producer. They are writing a ${p.bars}-bar loop at ${p.bpm} BPM in ${p.root} major / its relative minor.
Current tracks (MIDI, 16th-note steps):
${(["drums", "bass", "lead"] as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}

They want a suggestion for the ${role}. Their intent (may be Japanese): """${intent}"""

Lyria RealTime will generate audio for ONLY this part, which will then be transcribed to MIDI.
Return exactly TWO candidates that interpret the intent differently (e.g. different register, rhythm density, or contour), so the user can compare and choose.
For each candidate:
- Pick ONE instrument from this list (they transcribe reliably): ${target === "bass" ? '"synth bass", "electric bass (fingered)", "upright bass"' : '"square-wave synth lead", "flute", "clarinet", "whistling", "ocarina", "marimba"'}. Never guitar, piano, strings, pads or choirs. The two candidates may use different instruments.
- Always include the words "solo", "monophonic", "dry" in the first prompt. No chords, no reverb.
- Describe the musical character that serves the intent and fits the other tracks (rhythm, register, contour, energy).
- 1 to 3 weighted prompts, short English phrases.
- density 0..1 (how busy), brightness 0..1, guidance 3..5.
- title: a short Japanese label (max 16 chars) that names the interpretation, e.g. "高音で歌い上げる".
- rationale: 2 sentences in Japanese explaining how this candidate interprets the intent and what trade-off it makes compared to the other candidate, written for a beginner.`;
  const r = await callJson<{ candidates: LyriaSpec[] }>(apiKey, prompt, {
    type: "OBJECT",
    properties: { candidates: { type: "ARRAY", items: SPEC_SCHEMA } },
    required: ["candidates"],
  });
  if (!r.candidates?.length) throw new Error("Gemini が候補を返しませんでした");
  return r.candidates.slice(0, 2);
}

/** 採用候補のゴーストノートについて、どんなフレーズなのかを初心者向けに説明する */
export async function explainGhost(apiKey: string, p: Project, target: TrackId, ghost: Note[], intent: string): Promise<string> {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const g = ghost.map((x) => `${x.step}:${names[x.pitch % 12]}${Math.floor(x.pitch / 12) - 1}x${x.len}`).join(" ");
  const prompt = `A beginner asked for: """${intent}""". Key ${p.root} major/relative minor, ${p.bpm} BPM, ${p.bars} bars of 16 steps.
Existing tracks:
${(["drums", "bass", "lead"] as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}
Proposed ${target} notes (step:pitch x length): ${g}

In Japanese, 3 short bullet points: (1) the shape of this phrase (rhythm, contour, repetition), (2) how it relates to the existing bass/chords (which notes are chord tones, any tension), (3) one concrete thing the user could change by hand to push it further toward their intent. Only state what you can see from the note data; do not invent.`;
  const r = await callJson<{ bullets: string[] }>(apiKey, prompt, {
    type: "OBJECT",
    properties: { bullets: { type: "ARRAY", items: { type: "STRING" } } },
    required: ["bullets"],
  });
  return r.bullets.map((b) => "・" + b.replace(/^[・\-\s]+/, "")).join("\n");
}
