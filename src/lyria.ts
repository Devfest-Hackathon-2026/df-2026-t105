import { GoogleGenAI } from "@google/genai";
import type { LyriaSpec } from "./state";

const SCALE: Record<string, string> = {
  C: "C_MAJOR_A_MINOR", "C#": "D_FLAT_MAJOR_B_FLAT_MINOR", D: "D_MAJOR_B_MINOR", "D#": "E_FLAT_MAJOR_C_MINOR",
  E: "E_MAJOR_D_FLAT_MINOR", F: "F_MAJOR_D_MINOR", "F#": "G_FLAT_MAJOR_E_FLAT_MINOR", G: "G_MAJOR_E_MINOR",
  "G#": "A_FLAT_MAJOR_F_MINOR", A: "A_MAJOR_G_FLAT_MINOR", "A#": "B_FLAT_MAJOR_G_MINOR", B: "B_MAJOR_A_FLAT_MINOR",
};

export type LyriaRun = {
  role: "lead" | "bass";
  spec: LyriaSpec;
  bpm: number;
  root: string;
  seconds: number;
  ctx: AudioContext;
  /** ストリームをそのまま鳴らす */
  monitor: boolean;
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
    run.role === "bass"
      ? { muteDrums: true }
      : { muteDrums: true, muteBass: true };
  await session.setWeightedPrompts({ weightedPrompts: run.spec.prompts });
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
