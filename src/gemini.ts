import type { LyriaSpec, Note, Project, TrackId } from "./state";
import { describeTrack } from "./state";

const MODEL = "gemini-flash-latest";

async function callJson<T>(apiKey: string, prompt: string, schema: object): Promise<T> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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

/** 「こうしたい」という言葉と今の曲の中身から、Lyria に渡すプロンプトと設定を作る */
export async function intentToSpec(apiKey: string, p: Project, target: TrackId, intent: string): Promise<LyriaSpec> {
  const role = target === "bass" ? "bassline" : "lead melody";
  const prompt = `You help a beginner music producer. They are writing a ${p.bars}-bar loop at ${p.bpm} BPM in ${p.root} major / its relative minor.
Current tracks (MIDI, 16th-note steps):
${(["drums", "bass", "lead"] as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}

They want a suggestion for the ${role}. Their intent (may be Japanese): """${intent}"""

Lyria RealTime will generate audio for ONLY this part, which will then be transcribed to MIDI. So:
- The audio will be transcribed to MIDI, so pick ONE instrument from this list (they transcribe reliably): ${target === "bass" ? '"synth bass", "electric bass (fingered)", "upright bass"' : '"square-wave synth lead", "flute", "clarinet", "whistling", "ocarina", "marimba"'}. Never guitar, piano, strings, pads or choirs.
- Always include the words "solo", "monophonic", "dry" in the first prompt. No chords, no reverb.
- Describe the musical character that serves the intent and fits the other tracks (rhythm, register, contour, energy).
- 1 to 3 weighted prompts, short English phrases.
- density 0..1 (how busy), brightness 0..1, guidance 3..5.
- rationale: 2-3 sentences in Japanese explaining WHY these choices match the intent and the existing tracks, written for a beginner.`;
  return callJson<LyriaSpec>(apiKey, prompt, {
    type: "OBJECT",
    properties: {
      prompts: {
        type: "ARRAY",
        items: { type: "OBJECT", properties: { text: { type: "STRING" }, weight: { type: "NUMBER" } }, required: ["text", "weight"] },
      },
      density: { type: "NUMBER" },
      brightness: { type: "NUMBER" },
      guidance: { type: "NUMBER" },
      rationale: { type: "STRING" },
    },
    required: ["prompts", "density", "brightness", "guidance", "rationale"],
  });
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
