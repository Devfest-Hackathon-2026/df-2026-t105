import { GoogleGenAI } from "@google/genai";
import type { LyriaSpec } from "./state";

const SCALE: Record<string, string> = {
  C: "C_MAJOR_A_MINOR", "C#": "D_FLAT_MAJOR_B_FLAT_MINOR", D: "D_MAJOR_B_MINOR", "D#": "E_FLAT_MAJOR_C_MINOR",
  E: "E_MAJOR_D_FLAT_MINOR", F: "F_MAJOR_D_MINOR", "F#": "G_FLAT_MAJOR_E_FLAT_MINOR", G: "G_MAJOR_E_MINOR",
  "G#": "A_FLAT_MAJOR_F_MINOR", A: "A_MAJOR_G_FLAT_MINOR", "A#": "B_FLAT_MAJOR_G_MINOR", B: "B_MAJOR_A_FLAT_MINOR",
};

export type LyriaRun = {
  role: "lead" | "bass" | "drums";
  spec: LyriaSpec;
  bpm: number;
  root: string;
  seconds: number;
  ctx: AudioContext;
  /** ストリームをそのまま鳴らす */
  monitor: boolean;
  /** 既存トラックの内容を伝える英語の説明。weighted prompt として追加する */
  context?: string;
  onProgress: (sec: number) => void;
};

/** Lyria RealTime から seconds 秒ぶん受け取り、AudioBuffer にして返す */
export async function generate(apiKey: string, run: LyriaRun): Promise<AudioBuffer> {
  // キーがなければ、同じオリジンの中継サーバーに WebSocket をつなぐ（キーはサーバー側で付ける）
  const ai = apiKey
    ? new GoogleGenAI({ apiKey, apiVersion: "v1alpha" })
    : new GoogleGenAI({ apiKey: "via-proxy", apiVersion: "v1alpha", httpOptions: { baseUrl: location.origin } });
  const chunks: Int16Array[] = [];
  let mime = "";
  let frames = 0;
  let playHead = 0;
  const monitorGain = run.ctx.createGain();
  monitorGain.gain.value = 0.7;
  monitorGain.connect(run.ctx.destination);

  let finish!: () => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => ((finish = res), (fail = rej)));
  // 接続直後に失敗すると、await する前に reject されて未処理扱いになるのを防ぐ
  done.catch(() => {});

  const session = await ai.live.music.connect({
    model: "models/lyria-realtime-exp",
    callbacks: {
      onmessage: (m) => {
        for (const c of m.serverContent?.audioChunks ?? []) {
          if (!c.data) continue;
          mime ||= c.mimeType ?? "";
          const bin = atob(c.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const pcm = new Int16Array(bytes.buffer);
          chunks.push(pcm);
          frames += pcm.length / 2;
          const sr = rate();
          if (run.monitor) {
            const b = toBuffer(run.ctx, [pcm], sr);
            const src = run.ctx.createBufferSource();
            src.buffer = b;
            src.connect(monitorGain);
            playHead = Math.max(playHead, run.ctx.currentTime + 0.1);
            src.start(playHead);
            playHead += b.duration;
          }
          run.onProgress(frames / sr);
          if (frames / sr >= run.seconds) {
            session.close();
            finish();
          }
        }
      },
      onerror: (e) => fail(new Error(`Lyria に接続できませんでした${(e as ErrorEvent)?.message ? `: ${(e as ErrorEvent).message}` : ""}`)),
      onclose: (e) => (frames ? finish() : fail(new Error(`Lyria の接続が閉じました: ${(e as CloseEvent)?.code ?? ""} ${(e as CloseEvent)?.reason ?? ""}`))),
    },
  });
  const rate = () => Number(/rate=(\d+)/.exec(mime)?.[1] ?? 48000);

  const roleCfg =
    run.role === "drums"
      ? { onlyBassAndDrums: true, muteBass: true }
      : run.role === "bass"
        ? { muteDrums: true }
        : { muteDrums: true, muteBass: true };
  await session.setWeightedPrompts({
    weightedPrompts: run.context ? [...run.spec.prompts, { text: run.context, weight: 0.6 }] : run.spec.prompts,
  });
  await session.setMusicGenerationConfig({
    musicGenerationConfig: {
      bpm: run.bpm,
      scale: SCALE[run.root] as never,
      density: run.spec.density,
      brightness: run.spec.brightness,
      guidance: run.spec.guidance,
      ...roleCfg,
    },
  });
  await session.play();
  const timeout = setTimeout(() => { session.close(); finish(); }, (run.seconds + 45) * 1000);
  await done;
  clearTimeout(timeout);
  setTimeout(() => monitorGain.disconnect(), Math.max(0, (playHead - run.ctx.currentTime) * 1000) + 500);
  if (!frames) throw new Error("Lyria から音声が届きませんでした");
  return toBuffer(run.ctx, chunks, rate());
}

function toBuffer(ctx: AudioContext, chunks: Int16Array[], sr: number): AudioBuffer {
  const n = chunks.reduce((s, c) => s + c.length / 2, 0);
  const buf = ctx.createBuffer(2, Math.max(1, n), sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 2) {
      L[o] = c[i] / 32768;
      R[o] = c[i + 1] / 32768;
      o++;
    }
  }
  return buf;
}

/** buf の startSec から seconds 秒を切り出す */
export function slice(ctx: BaseAudioContext, buf: AudioBuffer, startSec: number, seconds: number): AudioBuffer {
  const s0 = Math.max(0, Math.round(startSec * buf.sampleRate));
  const n = Math.round(seconds * buf.sampleRate);
  const out = ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buf.getChannelData(ch).subarray(s0, Math.min(buf.length, s0 + n)));
  }
  return out;
}

// ---------- 非リアルタイムのモデル（Lyria 3.5 / 3 Clip） ----------
// RealTime より音が良いが、BPM とキーは設定値で渡せず、プロンプトの文章で伝えるしかない。
// 実測ではテンポとキーを守らないことがあるので、耳コピのあとで曲のテンポとキーに合わせる（clean.js の conform）。

export type ClipModel = "lyria-3.5" | "lyria-3-clip-preview";

export function buildClipPrompt(spec: LyriaSpec, o: { bpm: number; keyName: string; role: "lead" | "bass" | "drums"; seconds: number; context?: string }): string {
  const body = spec.prompts.map((p) => p.text).join(", ");
  const parts = o.role === "drums" ? "drum kit only, no melody, no bass" : "no drums, no chords, no other instruments";
  const key = o.role === "drums" ? "" : `, key of ${o.keyName}`;
  const ctx = o.context ? ` ${o.context}` : "";
  return `[0:00 - 0:${String(o.seconds).padStart(2, "0")}] A short loop: ${body}.${ctx} ${parts}. Strict steady tempo of ${o.bpm} BPM in 4/4${key}. Deliver ONLY the requested isolated part as a dry DAW stem. Any described accompaniment is reference ONLY and must NOT be rendered. Instrumental only, no vocals, no singing. The track ends at 0:${String(o.seconds).padStart(2, "0")}.`;
}

/** generateContent で生成し、音声を AudioBuffer にして返す。音声が返らないことがあるので3回まで試す */
export async function generateClip(
  apiKey: string,
  o: { model: ClipModel; prompt: string; ctx: AudioContext },
): Promise<{ buffer: AudioBuffer; text: string; model: string }> {
  if (!apiKey) return generateClipViaServer(o);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${o.model}:generateContent`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { "x-goog-api-key": apiKey } : {}) },
      body: JSON.stringify({ contents: [{ parts: [{ text: o.prompt }] }], generationConfig: { responseModalities: ["AUDIO", "TEXT"] } }),
    });
    if (!r.ok) {
      lastErr = `${o.model} ${r.status}: ${(await r.text()).slice(0, 200)}`;
      if (r.status === 402 || r.status === 400 || r.status === 403) break;
      continue;
    }
    const j = await r.json();
    const parts: { text?: string; inlineData?: { data: string; mimeType: string } }[] = j.candidates?.[0]?.content?.parts ?? [];
    const audio = parts.find((p) => p.inlineData?.data);
    const text = parts.filter((p) => p.text).map((p) => p.text).join("\n");
    if (!audio) { lastErr = `${o.model} が音声を返しませんでした`; continue; }
    const bin = atob(audio.inlineData!.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { buffer: await o.ctx.decodeAudioData(bytes.buffer), text, model: j.modelVersion ?? o.model };
  }
  throw new Error(lastErr || `${o.model} の生成に失敗しました`);
}

/** 中継サーバーの /api/music に頼む。サーバーが AI Studio と Vertex のどちらを使うかは画面からは見えない */
async function generateClipViaServer(o: { model: ClipModel; prompt: string; ctx: AudioContext }) {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${location.origin}/api/music/${o.model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: o.prompt }),
    });
    if (!r.ok) {
      lastErr = `作曲に失敗しました（${r.status}）: ${(await r.text()).slice(0, 200)}`;
      if ([400, 402, 403, 429].includes(r.status)) break;
      continue;
    }
    const j: { audio: string | null; mime: string | null; text: string; model: string } = await r.json();
    if (!j.audio) { lastErr = `${j.model} が音声を返しませんでした`; continue; }
    const bin = atob(j.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { buffer: await o.ctx.decodeAudioData(bytes.buffer), text: j.text, model: j.model };
  }
  throw new Error(lastErr || "作曲に失敗しました");
}

/** 中継サーバーが使えるモデル。サーバーなしの開発（キーを画面に入れる）では null */
export async function serverConfig(): Promise<{ backend: string; realtime: boolean; musicModels: Record<string, string> } | null> {
  try {
    const r = await fetch(`${location.origin}/api/config`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
