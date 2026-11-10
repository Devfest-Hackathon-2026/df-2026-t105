import type { LyriaSpec, Note, Project, TrackId } from "./state";
import { describeTrack, trackRole } from "./state";

const MODEL = "gemini-flash-latest";

async function callJson<T>(apiKey: string, prompt: string, schema: object, thinkingLevel: "low" | "high" = "low"): Promise<T> {
  // キーがあれば直接呼ぶ。なければ同じオリジンの中継サーバー（server/index.mjs）を通す
  const url = apiKey
    ? `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
    : `${location.origin}/api/gemini/${MODEL}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { "x-goog-api-key": apiKey } : {}) },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingLevel } },
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
export async function intentToSpecs(apiKey: string, p: Project, target: TrackId, intent: string, count: number = 1): Promise<LyriaSpec[]> {
  const targetRole = trackRole(p,target);
  const targetTrack = p.tracks[target];
  const preferredInst = targetTrack?.instrument ? targetTrack.instrument.replace(/_/g, " ") : "";
  const role = targetRole === "bass" ? "bassline" : targetRole === "drums" ? "drum pattern" : `melodic/harmonic part (${preferredInst || "lead"})`;
  const instrumentRules =
    targetRole === "drums"
      ? `- Use a dry drum kit. Choose kick, snare, hi-hat, toms, ride, crash, brushes or percussion as appropriate to the requested style; preserve fills and fast subdivisions.
- Do not include bass or pitched instruments. Deliver the drum part only.
- Require a continuous, non-stop groove across all ${p.bars} bars starting immediately on beat 1 with no intro, no outro, and no silent breakdown bars.`
      : `- Use ${preferredInst ? `"${preferredInst}" (or a closely matching ${targetRole} instrument if requested in the user's intent)` : targetRole === "bass" ? '"synth bass", "electric bass (fingered)", or "upright bass"' : '"acoustic piano", "electric piano", "clean electric guitar", "flute", "synth lead", or the instrument requested by the user'}.
- Always include the words "solo", "dry", "continuous ${p.bars}-bar loop, no intro, no rests" in the first prompt. No drums or accompaniment.`;
  const prompt = `You help a beginner music producer. They are writing a ${p.bars}-bar loop at ${p.bpm} BPM in ${p.root} major / its relative minor.
Current tracks (MIDI, 16th-note steps):
${(Object.keys(p.tracks) as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}

They want a suggestion for the ${role}. Their intent (may be Japanese): """${intent}"""

Lyria will generate audio for ONLY this part, which will then be transcribed to MIDI.
${count === 1 ? "Return exactly ONE candidate that fits the intent." : `Return exactly ${count} candidates with different interpretations of the intent (register, rhythm density, contour).`}
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
  const targetRole = trackRole(p,target);
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const drum: Record<number, string> = { 36: "kick", 38: "snare", 42: "hat" };
  const g = targetRole === "drums"
    ? ghost.map((x) => `${x.step}:${drum[x.pitch] ?? x.pitch}`).join(" ")
    : ghost.map((x) => `${x.step}:${names[x.pitch % 12]}${Math.floor(x.pitch / 12) - 1}x${x.len}`).join(" ");
  const prompt = `A beginner asked for: """${intent}""". Key ${p.root} major/relative minor, ${p.bpm} BPM, ${p.bars} bars of 16 steps.
Existing tracks:
${(Object.keys(p.tracks) as TrackId[]).map((id) => "- " + describeTrack(p, id)).join("\n")}
Proposed ${target} notes (step:pitch x length): ${g}

In Japanese, 3 short bullet points: (1) the shape of this phrase (rhythm, contour, repetition), (2) ${targetRole === "drums" ? "how it locks with the existing bassline rhythm (which bass notes share a step with the kick)" : "how it relates to the existing bass/chords (which notes are chord tones, any tension)"}, (3) one concrete thing the user could change by hand to push it further toward their intent. Only state what you can see from the note data; do not invent.`;
  const r = await callJson<{ bullets: string[] }>(apiKey, prompt, {
    type: "OBJECT",
    properties: { bullets: { type: "ARRAY", items: { type: "STRING" } } },
    required: ["bullets"],
  });
  return r.bullets.map((b) => "・" + b.replace(/^[・\-\s]+/, "")).join("\n");
}

// ---------- 提案を言葉で直す ----------

export type RevisionChange = { where: string; what: string; why: string };
export type Revision = { notes: Note[]; summary: string; changes: RevisionChange[] };

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitchName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** 16分を1とするステップを「小節.拍」で書く（小節・拍とも1始まり。拍は小数で、0.25 が16分音符1つ） */
const at = (step: number) => `bar ${Math.floor(step / 16) + 1} beat ${round3((step % 16) / 4 + 1)}`;

/**
 * 耳コピした提案を、利用者の言葉（「もっと滑らかに」など）に沿って直した版を作る。
 * 返すのは直したあとの音すべてと、変えた箇所ごとの音楽的な理由。
 * 提案を書き換えるのではなく、別の案として並べるために使う（採るかどうかは利用者が決める）。
 */
export async function reviseGhost(
  apiKey: string,
  p: Project,
  target: TrackId,
  ghost: { notes: Note[]; startStep: number; bars: number },
  intent: string,
  instruction: string,
): Promise<Revision> {
  const role = trackRole(p, target);
  const from = ghost.startStep, to = ghost.startStep + ghost.bars * 16;
  const inWindow = (n: Note) => n.step < to && n.step + n.len > from;
  const fmt = (n: Note) => `${at(n.step)}: ${pitchName(n.pitch)} (midi ${n.pitch}), ${round3(n.len / 4)} beats, vel ${round3(n.vel)}`;
  const context = (Object.keys(p.tracks) as TrackId[])
    .map((id) => {
      const t = p.tracks[id];
      const notes = t.notes.filter(inWindow).sort((a, b) => a.step - b.step || a.pitch - b.pitch);
      if (!notes.length) return "";
      const head = `${t.name} (${trackRole(p, id)}${id === target ? ", the same track as the proposal; notes the user already has" : ""})`;
      return `${head}:\n` + notes.map((n) => "  " + fmt(n)).join("\n");
    })
    .filter(Boolean)
    .join("\n");
  const proposal = [...ghost.notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch).map((n) => "  " + fmt(n)).join("\n");
  const prompt = `You are a music teacher helping a beginner producer edit a transcribed phrase.
Song: ${p.bpm} BPM, 4/4, key ${p.root} major / its relative minor. Positions are "bar N beat B" (both 1-based; beat 1.5 = the "and" of beat 1; 0.25 beat = one 16th note).
The phrase covers bars ${Math.floor(from / 16) + 1}-${Math.floor(to / 16)} (beat 1 of bar ${Math.floor(from / 16) + 1} up to, but not including, beat 1 of bar ${Math.floor(to / 16) + 1}).
The user originally asked for: """${intent}"""

Other parts in the same bars:
${context || "  (none)"}

Proposed ${role} phrase (transcribed from audio):
${proposal || "  (empty)"}

The user now asks you to revise this phrase: """${instruction}"""

Rules:
- Return the COMPLETE revised phrase (every note, changed or not) in "notes". Keep notes you do not need to change exactly as they are (same bar, beat, pitch, beats).
- Make the smallest set of changes that clearly achieves the request, and keep the character of the original phrase. Do not rewrite everything.
- Stay inside the phrase's bars. ${role === "drums" ? "Use General MIDI drum note numbers." : "Keep the register playable for this instrument (roughly the same range as the original)."}
- Fit the other parts: check chord tones against the bass/chords sounding at the same time, and the rhythm against the drums.
- "changes": one entry per musical change (group related notes). "where": the position in Japanese like "3小節目 2拍目". "what": what changed, with note names, e.g. "E5→C5 の跳躍を E5→D5→C5 に". "why": the musical reason in Japanese, for a beginner. Name the concept (順次進行, 跳躍の後の反行, 経過音, 刺繍音, コードトーン, 倚音と解決, シンコペーション, 音域, 動機の反復 など) and explain it in one plain sentence. Only state what is true of the given notes.
- "summary": one short Japanese sentence describing the overall revision.`;
  const r = await callJson<{ summary: string; notes: { bar: number; beat: number; pitch: number; beats: number; velocity?: number }[]; changes: RevisionChange[] }>(
    apiKey,
    prompt,
    {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING" },
        changes: {
          type: "ARRAY",
          items: { type: "OBJECT", properties: { where: { type: "STRING" }, what: { type: "STRING" }, why: { type: "STRING" } }, required: ["where", "what", "why"] },
        },
        notes: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { bar: { type: "INTEGER" }, beat: { type: "NUMBER" }, pitch: { type: "INTEGER" }, beats: { type: "NUMBER" }, velocity: { type: "NUMBER" } },
            required: ["bar", "beat", "pitch", "beats"],
          },
        },
      },
      required: ["summary", "changes", "notes"],
    },
    "low",
  );
  return { summary: r.summary ?? "", changes: r.changes ?? [], notes: sanitizeRevision(r.notes ?? [], ghost, role === "drums") };
}

/**
 * Gemini が返した音を、アプリで扱える音符にする。
 * 範囲外・音域外の音は捨てる。元の提案とほぼ同じ音は元の値をそのまま使う（耳コピの細かい発音時刻を保つ）。
 */
export function sanitizeRevision(
  raw: { bar: number; beat: number; pitch: number; beats: number; velocity?: number }[],
  ghost: { notes: Note[]; startStep: number; bars: number },
  drums: boolean,
): Note[] {
  const from = ghost.startStep, to = ghost.startStep + ghost.bars * 16;
  const lo = drums ? 27 : Math.max(0, Math.min(...ghost.notes.map((n) => n.pitch), 127) - 12);
  const hi = drums ? 87 : Math.min(127, Math.max(...ghost.notes.map((n) => n.pitch), 0) + 12);
  const avgVel = ghost.notes.length ? ghost.notes.reduce((a, n) => a + n.vel, 0) / ghost.notes.length : 0.8;
  const used = new Set<Note>();
  const out: Note[] = [];
  for (const r of raw) {
    if (![r.bar, r.beat, r.pitch, r.beats].every(Number.isFinite)) continue;
    const step = (r.bar - 1) * 16 + (r.beat - 1) * 4;
    const pitch = Math.round(r.pitch);
    if (step < from - 1e-6 || step >= to || pitch < lo || pitch > hi) continue;
    const len = Math.max(0.25, Math.min(r.beats * 4, to - step));
    const vel = Number.isFinite(r.velocity) ? Math.max(0.05, Math.min(1, r.velocity!)) : undefined;
    // 渡した値は小数3桁に丸めているので、その誤差（0.01 ステップ）以内なら元の音とみなす。
    // 位置は元の値を保ち（耳コピの細かい発音時刻を崩さない）、長さと強さは AI が変えたときだけ新しい値にする
    const same = ghost.notes.find((n) => !used.has(n) && n.pitch === pitch && Math.abs(n.step - step) < 0.01);
    if (same) {
      used.add(same);
      const sameLen = Math.abs(r.beats * 4 - same.len) < 0.01;
      const sameVel = vel === undefined || Math.abs(vel - same.vel) < 0.01;
      out.push({ ...same, len: sameLen ? same.len : len, vel: sameVel ? same.vel : vel! });
      continue;
    }
    out.push({ step, len, pitch, vel: vel ?? avgVel });
  }
  // 同じ位置・同じ高さの重複を除く
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.step - b.step || a.pitch - b.pitch)
    .filter((n) => { const k = `${n.pitch}@${n.step.toFixed(3)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
