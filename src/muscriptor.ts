import { muscriptorNotes } from "./core/muscriptor.js";
import { findGridPhase } from "./core/clean.js";
import type { Note } from "./state";
import { encodeMonoWav } from "./wav";

export type MusNote = { pitch: number; start: number; end: number; instrument: string };

/** 中継サーバー経由で muscriptor に採譜を頼む（サーバーに MUSCRIPTOR_URL が設定されているときだけ使える） */
export async function transcribeWithMuscriptor(mono: Float32Array, sampleRate: number, instruments: string[], backend: "cpu" | "a100" = "cpu", onStatus: (text: string) => void = () => {}): Promise<MusNote[]> {
  const r = await fetch(`${location.origin}/api/transcription-jobs?instruments=${encodeURIComponent(instruments.join(","))}&backend=${backend}`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeMonoWav(mono, sampleRate),
  });
  if (!r.ok) throw new Error(`採譜ジョブを開始できませんでした（${r.status}）: ${(await r.text()).slice(0, 200)}`);
  const { id } = await r.json();
  const phases: Record<string,string> = { queued: "採譜の順番を待っています", allocating: "A100を確保しています", loading: "MuScriptorを準備しています", preparing: "採譜の準備をしています", transcribing: "MuScriptorで採譜しています" };
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${location.origin}/api/transcription-jobs/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("採譜ジョブの状態を確認できませんでした");
    const job = await response.json();
    if (job.status === "done") return muscriptorNotes(job.events);
    if (job.status === "error") throw new Error(job.error);
    onStatus(phases[job.phase] ?? phases[job.status] ?? "採譜しています");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("採譜ジョブが時間内に完了しませんでした。サーバーを確認してください");
}

/** GM のドラムの音番号を、Ghostnotes の3つの行（キック 36、スネア 38、ハイハット 42）にまとめる */
function drumRow(p: number): number | null {
  if (p === 35 || p === 36) return 36;
  if (p >= 37 && p <= 40) return 38;
  if (p === 42 || p === 44 || p === 46) return 42;
  return null;
}
const DRUM_VEL: Record<number, number> = { 36: 0.9, 38: 0.85, 42: 0.55 };

/**
 * muscriptor のドラムの採譜結果を、ゴーストノートにする。
 * 16分の格子の位相は全打点から求め、小節の頭は「キックが1・3拍目、スネアが2・4拍目」に一番よく合う拍を選ぶ。
 */
export function drumsToGhost(hits: MusNote[], bpm: number, bars: number): { notes: Note[]; startSec: number } {
  const step = 60 / bpm / 4;
  const rows = hits.map((h) => ({ ...h, row: drumRow(h.pitch) })).filter((h) => h.row !== null) as (MusNote & { row: number })[];
  if (!rows.length) return { notes: [], startSec: 0 };
  const { phase } = findGridPhase(rows.map((h) => ({ startTimeSeconds: h.start, amplitude: h.row === 42 ? 0.5 : 1 })), bpm);
  const steps = bars * 16;
  const quantize = (s0: number) => {
    const seen = new Set<string>();
    const out: Note[] = [];
    for (const h of rows) {
      const x = (h.start - s0) / step, k = Math.round(x);
      if (k < 0 || k >= steps || Math.abs(x - k) > 0.35) continue;
      const key = `${k}:${h.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ step: k, len: 1, pitch: h.row, vel: DRUM_VEL[h.row] + (h.row === 42 && k % 4 === 0 ? 0.15 : 0) });
    }
    return out;
  };
  // 1秒より後の最初の小節頭を基準に、1拍ずつずらした4候補から選ぶ
  const barSec = step * 16;
  const base = phase + Math.ceil((1 - phase) / barSec) * barSec;
  let best = { startSec: base, notes: quantize(base), score: -1 };
  for (let beat = 0; beat < 4; beat++) {
    const s0 = base + beat * step * 4;
    const notes = quantize(s0);
    const score = notes.filter((n) => (n.pitch === 36 && n.step % 8 === 0) || (n.pitch === 38 && n.step % 8 === 4)).length;
    if (score > best.score) best = { startSec: s0, notes, score };
  }
  return { notes: best.notes.sort((a, b) => a.step - b.step || a.pitch - b.pitch), startSec: best.startSec };
}
