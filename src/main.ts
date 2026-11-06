import "./style.css";
import { Engine } from "./audio";
import { cleanToGhost, NOTE_NAMES } from "./core/clean.js";
import { downloadMidi, toMidiFile } from "./core/midi.js";
import { explainGhost, intentToSpecs } from "./gemini";
import { generate, slice } from "./lyria";
import { Roll } from "./roll";
import { demoProject, load, save, type Ghost, type LyriaSpec, type Note, type Project, type TrackId } from "./state";
import { toMono22k, transcribe, warmUp } from "./transcribe";
import { estimateStartSec, transcribeDrums } from "./core/drums.js";

let project: Project = load() ?? demoProject();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const engine = new Engine(() => project);
const roll = new Roll($("roll"), () => project, onEdit);
engine.onStep = (s) => { roll.playStep = s; roll.draw(); };

// ---------- API キー ----------
const KEY_STORE = "ghostnotes.apiKey";
const apiKeyInput = $<HTMLInputElement>("apiKey");
apiKeyInput.value = safeGet(KEY_STORE) ?? "";
apiKeyInput.addEventListener("change", () => safeSet(KEY_STORE, apiKeyInput.value.trim()));
function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }

// ---------- トランスポート ----------
const playBtn = $<HTMLButtonElement>("play");
playBtn.onclick = async () => {
  const willPlay = !engine.playing;
  if (willPlay) await engine.start();
  else engine.stop();
  playBtn.textContent = willPlay ? "■ 停止" : "▶ 再生";
};
const bpmInput = $<HTMLInputElement>("bpm");
bpmInput.value = String(project.bpm);
bpmInput.onchange = () => {
  project.bpm = Math.max(60, Math.min(200, Number(bpmInput.value) || 100));
  bpmInput.value = String(project.bpm);
  engine.setBpm(project.bpm);
  commit();
};
const keySel = $<HTMLSelectElement>("key");
keySel.innerHTML = NOTE_NAMES.map((n) => `<option value="${n}">${n} メジャー / ${NOTE_NAMES[(NOTE_NAMES.indexOf(n) + 9) % 12]} マイナー</option>`).join("");
keySel.value = project.root;
keySel.onchange = () => { project.root = keySel.value; commit(); };
$("reset").onclick = () => {
  if (!confirmInline($("reset"), "もう一度押すとデモ曲に戻します")) return;
  project = demoProject();
  for (const t of Object.values(project.tracks)) t.ghost = null;
  engine.setLyria(null);
  bpmInput.value = String(project.bpm);
  keySel.value = project.root;
  commit();
};

// 採用済みの音だけを書き出す（ゴーストは含めない）。GM の音色番号: 38 = Synth Bass 1、80 = Lead 1 (square)
$("exportMidi").onclick = () => {
  const tr = project.tracks;
  const bytes = toMidiFile(
    [
      { name: "Drums", channel: 9, notes: tr.drums.notes },
      { name: "Bass", channel: 1, program: 38, notes: tr.bass.notes },
      { name: "Lead", channel: 0, program: 80, notes: tr.lead.notes },
    ],
    { bpm: project.bpm },
  );
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  downloadMidi(bytes, `ghostnotes-${stamp}.mid`);
  setStatus("採用済みの音を MIDI に書き出しました（ゴーストは含みません）");
};

// A/B
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  b.onclick = () => {
    engine.mode = b.dataset.mode as "A" | "B" | "L";
    engine.applyMode();
    renderModes();
  };
}
function renderModes() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === engine.mode));
}

// ---------- トラック ----------
function renderTracks() {
  const box = $("tracks");
  box.innerHTML = "";
  for (const t of Object.values(project.tracks)) {
    const row = document.createElement("div");
    row.className = "track" + (roll.track === t.id ? " selected" : "");
    const g = t.ghost ? `<span class="badge">ゴースト ${t.ghost.notes.length}</span>` : "";
    row.innerHTML = `<button class="track-name">${t.name}</button>${g}<span class="count">${t.notes.length}音</span><button class="mute" aria-pressed="${t.mute}" title="ミュート">M</button>`;
    row.querySelector<HTMLButtonElement>(".track-name")!.onclick = () => { roll.track = t.id; targetSel.value = t.id; renderAll(); };
    row.querySelector<HTMLButtonElement>(".mute")!.onclick = () => { t.mute = !t.mute; commit(); };
    box.appendChild(row);
  }
}

function onEdit(kind: "add" | "remove" | "accept" | "reject", id: TrackId, n: Note) {
  const t = project.tracks[id];
  if (kind === "add") {
    if (id !== "drums") t.notes = t.notes.filter((x) => !(x.step < n.step + n.len && n.step < x.step + x.len));
    t.notes.push(n);
  } else if (kind === "remove") t.notes = t.notes.filter((x) => x !== n);
  else if (t.ghost) {
    const i = t.ghost.notes.indexOf(n);
    t.ghost.notes.splice(i, 1);
    t.ghost.conf.splice(i, 1);
    if (kind === "accept") {
      // ドラムは同じ位置に違う楽器（キックとハイハットなど）が並ぶので、同じ楽器の重なりだけを消す
      t.notes = t.notes.filter((x) => !(x.step < n.step + n.len && n.step < x.step + x.len && (id !== "drums" || x.pitch === n.pitch)));
      t.notes.push(n);
      project.log[t.ghost.logIndex].accepted++;
      t.ghost.accepted++;
    }
  }
  commit();
}

// ---------- ゴースト生成 ----------
const targetSel = $<HTMLSelectElement>("target");
const intentInput = $<HTMLTextAreaElement>("intent");
const askBtn = $<HTMLButtonElement>("ask");
const statusEl = $("status");
const monitorChk = $<HTMLInputElement>("monitor");

type Target = "lead" | "bass" | "drums";
const FALLBACK = (target: Target): LyriaSpec[] =>
  (target === "drums"
    ? [["dry drum kit, kick snare closed hi-hat, simple groove", "シンプルなビート"], ["dry drum kit, kick snare closed hi-hat, busy syncopated groove", "細かく刻むビート"]]
    : target === "bass"
    ? [["synth bass", "シンセベースで刻む"], ["electric bass fingered", "指弾きベースで歌う"]]
    : [["flute", "フルートで歌う"], ["square-wave synth lead", "シンセで跳ねる"]]
  ).map(([inst, title]) => ({
    title,
    prompts: [{ text: target === "drums" ? inst : `solo monophonic dry ${inst}, single notes`, weight: 1 }],
    density: 0.4, brightness: 0.5, guidance: 4.5,
    rationale: "（Gemini に繋がらなかったので、既定の指示で生成しました）",
  }));

askBtn.onclick = async () => {
  const apiKey = apiKeyInput.value.trim();
  const target = targetSel.value as Target;
  const intent = intentInput.value.trim() || "この曲に合うシンプルなフレーズ";
  askBtn.disabled = true;
  try {
    setStatus("1/4 意図を2通りに解釈して、Lyria への指示にしています（Gemini）");
    let specs: LyriaSpec[];
    try {
      specs = await intentToSpecs(apiKey, project, target, intent);
    } catch (e) {
      console.warn(e);
      specs = FALLBACK(target);
    }
    const barSec = (60 / project.bpm) * 4;
    const seconds = 2 + barSec * (project.bars + 1);
    const prog = specs.map(() => 0);
    const showProg = () => setStatus(`2/4 Lyria が${specs.length}案を同時に演奏しています… ${Math.min(...prog).toFixed(0)} / ${seconds.toFixed(0)} 秒`);
    showProg();
    // 2案を同時に生成する。生成中の試聴は案Aだけ鳴らす
    const fulls = await Promise.all(specs.map((spec, k) =>
      generate(apiKey, {
        role: target, spec, bpm: project.bpm, root: project.root, seconds,
        ctx: engine.context, monitor: monitorChk.checked && k === 0,
        onProgress: (sec) => { prog[k] = sec; showProg(); },
      }),
    ));

    project.log.push({
      at: new Date().toISOString(), track: target, intent, spec: specs[0], proposed: 0, accepted: 0, reason: "",
      titles: specs.map((sp, k) => `${LABELS[k]}: ${sp.title ?? ""}`),
    });
    const logIndex = project.log.length - 1;
    const t = project.tracks[target];
    t.alts = [];
    roll.track = target;
    for (let k = 0; k < specs.length; k++) {
      setStatus(target === "drums" ? `3/4 案${LABELS[k]}のキック・スネア・ハイハットを拾っています` : `3/4 案${LABELS[k]}を耳コピしています（basic-pitch）`);
      let g: Ghost;
      if (target === "drums") {
        g = await makeDrumGhost(intent, specs[k], fulls[k], logIndex, k);
      } else {
        const raw = await transcribe(fulls[k], (p) => setStatus(`3/4 案${LABELS[k]}を耳コピしています（basic-pitch） ${Math.round(p * 100)}%`));
        g = makeGhost(target, intent, specs[k], fulls[k], raw, logIndex, k);
      }
      t.alts.push(g);
      // 最初の案ができた時点で見せる（2案目の耳コピを待たせない）
      if (k === 0) { showAlt(target, 0); }
      else commit();
      explainGhost(apiKey, project, target, g.notes, intent)
        .catch(() => "（説明を取得できませんでした）")
        .then((x) => { g.explanation = x; renderGhostPanel(); });
    }
    if (!t.alts.some((g) => g.notes.length)) throw new Error("音を拾えませんでした。もう一度試すか、意図の書き方を変えてください");
    project.log[logIndex].proposed = Math.max(...t.alts.map((g) => g.proposed));
    commit();
    setStatus(`${t.alts.length}案が届きました。案を切り替えて聴き比べ（キー 1 / 2）、クリックで1音ずつ採用、Tab で全部採用`);
  } catch (e) {
    console.error(e);
    setStatus(String((e as Error).message ?? e), true);
  } finally {
    askBtn.disabled = false;
  }
};

const LABELS = ["A", "B", "C"];

/**
 * ドラムのゴーストを作る（試験的）。Lyria にドラムだけを叩かせ、帯域ごとの音の立ち上がりから
 * キック・スネア・ハイハットの位置を拾う。basic-pitch は音の高さを持つ楽器向けなので使わない。
 */
async function makeDrumGhost(intent: string, spec: LyriaSpec, full: AudioBuffer, logIndex: number, k: number): Promise<Ghost> {
  const mono = await toMono22k(full);
  const startSec = estimateStartSec(mono, 22050, project.bpm);
  const g: Ghost = {
    notes: [], conf: [], full, startSec, sourceBpm: project.bpm, raw: [], mono, ampRatio: 0.5,
    spec, intent, explanation: "", logIndex, label: LABELS[k], proposed: 0, accepted: 0,
  };
  redetectDrums(g, 0.5);
  g.proposed = g.notes.length;
  return g;
}
function redetectDrums(g: Ghost, sensitivity: number) {
  g.ampRatio = sensitivity;
  const all = transcribeDrums(g.mono!, 22050, { bpm: g.sourceBpm, startSec: g.startSec, bars: project.bars, sensitivity })
    .filter((n) => n.vel >= 0.15);
  // 低音域にベースが混ざると、キックをほぼ全ステップで拾ってしまう。キックとスネアは強い順に半分のステップまでに絞る
  // （評価用の音源では、4小節あたり 11〜24 音だった）
  const cap = project.bars * 8;
  g.notes = [36, 38, 42]
    .flatMap((p) => {
      const hits = all.filter((n) => n.pitch === p).sort((a, b) => b.vel - a.vel);
      return p === 42 ? hits : hits.slice(0, cap);
    })
    .sort((a, b) => a.step - b.step || a.pitch - b.pitch);
  g.conf = g.notes.map((n) => Math.min(1, 0.3 + 0.7 * n.vel));
}

/** 耳コピの生の結果からゴーストを作る。startSec と sourceBpm を渡すと、推定をやり直さずにその値を使う */
function makeGhost(
  target: "lead" | "bass", intent: string, spec: LyriaSpec, full: AudioBuffer, raw: Ghost["raw"], logIndex: number, k: number,
  fixed?: { startSec: number; sourceBpm: number },
): Ghost {
  const res = cleanToGhost(raw, { bpm: project.bpm, root: project.root, role: target, bars: project.bars, ...(fixed ?? {}) });
  return {
    notes: res.notes, conf: confidence(res.notes, project.bars * 16), full, startSec: res.startSec, sourceBpm: res.sourceBpm, raw, ampRatio: 0.35,
    spec, intent, explanation: "", logIndex, label: LABELS[k], proposed: res.notes.length, accepted: 0,
  };
}

// ---------- デモモード（?demo）と書き出し（?debug） ----------
// 実演で生成が遅れたり失敗したりしたときのために、事前に生成した提案をすぐ出せるようにする。
// 事前生成であることは画面に明示する。
type DemoSet = {
  intent: string; target: "lead" | "bass"; bpm: number; root: string; createdAt: string;
  cands: { spec: LyriaSpec; explanation: string; raw: Ghost["raw"]; startSec: number; sourceBpm: number; audio: string }[];
};
const params = new URLSearchParams(location.search);
if (params.has("demo")) {
  const btn = $<HTMLButtonElement>("demoBtn");
  btn.hidden = false;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      setStatus("事前に生成した提案を読み込んでいます");
      const set = (await (await fetch(`${import.meta.env.BASE_URL}demo/set.json`)).json()) as DemoSet;
      if (set.bpm !== project.bpm || set.root !== project.root) {
        project.bpm = set.bpm; project.root = set.root; bpmInput.value = String(set.bpm); keySel.value = set.root; engine.setBpm(set.bpm);
      }
      targetSel.value = set.target;
      intentInput.value = set.intent;
      const fulls = await Promise.all(set.cands.map(async (c) =>
        engine.context.decodeAudioData(await (await fetch(`${import.meta.env.BASE_URL}demo/${c.audio}`)).arrayBuffer())));
      project.log.push({
        at: new Date().toISOString(), track: set.target, intent: set.intent, spec: set.cands[0].spec, proposed: 0, accepted: 0, reason: "",
        titles: set.cands.map((c, k) => `${LABELS[k]}: ${c.spec.title ?? ""}（事前生成）`),
      });
      const logIndex = project.log.length - 1;
      const t = project.tracks[set.target];
      t.alts = set.cands.map((c, k) => {
        const g = makeGhost(set.target, set.intent, c.spec, fulls[k], c.raw, logIndex, k, { startSec: c.startSec, sourceBpm: c.sourceBpm });
        g.explanation = c.explanation;
        return g;
      });
      project.log[logIndex].proposed = Math.max(...t.alts.map((g) => g.proposed));
      roll.track = set.target;
      showAlt(set.target, 0);
      setStatus(`事前に生成した2案を表示しています（${new Date(set.createdAt).toLocaleString("ja-JP")} に生成）`);
    } catch (e) {
      setStatus(`デモ用の提案を読み込めませんでした: ${(e as Error).message}`, true);
    } finally {
      btn.disabled = false;
    }
  };
}
if (params.has("debug")) {
  // scripts/make-demo.mjs が、いま表示している2案をデモ用に書き出すときに使う
  (window as unknown as { __ghostnotesExport: () => unknown }).__ghostnotesExport = () => {
    const t = project.tracks[roll.track];
    if (!t.alts) return null;
    return {
      intent: t.alts[0].intent, target: t.id, bpm: project.bpm, root: project.root, createdAt: new Date().toISOString(),
      cands: t.alts.map((g) => ({
        spec: g.spec, explanation: g.explanation, raw: g.raw, startSec: g.startSec, sourceBpm: g.sourceBpm,
        wav: wavBase64(g.full),
      })),
    };
  };
}
function wavBase64(buf: AudioBuffer): string {
  const n = buf.length, ch = buf.numberOfChannels, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o: number, str: string) => { for (let i = 0; i < str.length; i++) out.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(data[c][i] * 32767))), true);
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** 案を切り替える。採用済みの音はそのまま残り、ゴーストだけが入れ替わる */
function showAlt(id: TrackId, k: number) {
  const t = project.tracks[id];
  const g = t.alts?.[k];
  if (!g) return;
  t.ghost = g;
  applyLyriaSlice(g);
  commit();
}

/**
 * 耳コピの確からしさの目安。音量が大きく、ある程度長い音ほど誤検出が少ない。
 * 2小節（または1小節）離れた位置に同じ音があれば、繰り返しとして確かめられたとみなして上げる。
 */
function confidence(notes: Note[], steps: number): number[] {
  const at = new Map(notes.map((n) => [n.step, n.pitch]));
  return notes.map((n) => {
    const hits = [32, -32, 16, -16].filter((d) => at.get((n.step + d + steps) % steps) === n.pitch).length;
    return Math.min(1, 0.15 + 0.5 * n.vel + (n.len >= 2 ? 0.15 : 0) + 0.25 * hits);
  });
}

/** Lyria の原音から、ゴーストと同じ4小節を切り出す。演奏のテンポが曲とずれていれば再生速度で合わせる */
function applyLyriaSlice(g: Ghost) {
  const sec = (60 / g.sourceBpm) * 4 * project.bars;
  engine.setLyria(slice(engine.context, g.full, g.startSec, sec), project.bpm / g.sourceBpm);
}

function nudge(d: number) {
  const id = roll.track;
  const g = project.tracks[id].ghost;
  if (!g) return;
  const steps = project.bars * 16;
  for (const n of g.notes) n.step = (n.step + d + steps) % steps;
  g.notes.sort((a, b) => a.step - b.step);
  g.conf = confidence(g.notes, steps);
  g.startSec -= d * (60 / g.sourceBpm / 4);
  applyLyriaSlice(g);
  commit();
}
/** 拾う音の量を変えて、生成し直さずに整形だけやり直す */
function reclean(ampRatio: number) {
  const id = roll.track;
  const g = project.tracks[id].ghost;
  if (!g) return;
  if (id === "drums") {
    // ドラムでは「拾う音の量」を検出の感度として使う（右ほど小さな音まで拾う）
    redetectDrums(g, Math.max(0.05, Math.min(0.95, 1 - ampRatio)));
    commit();
    return;
  }
  g.ampRatio = ampRatio;
  const res = cleanToGhost(g.raw, { bpm: project.bpm, root: project.root, role: id, bars: project.bars, startSec: g.startSec, sourceBpm: g.sourceBpm, ampRatio });
  g.notes = res.notes;
  g.conf = confidence(g.notes, project.bars * 16);
  commit();
}

/** 1小節ぶんのゴーストをまとめて採用する（1音ずつ選ぶのが難しいとき用） */
function acceptBar(bar: number) {
  const g = project.tracks[roll.track].ghost;
  if (!g) return;
  for (const n of g.notes.filter((x) => Math.floor(x.step / 16) === bar)) onEdit("accept", roll.track, n);
}
function renderBarAccept() {
  const box = $("barAccept");
  const g = project.tracks[roll.track].ghost;
  box.hidden = !g;
  if (!g) return;
  const counts = Array.from({ length: project.bars }, (_, b) => g.notes.filter((x) => Math.floor(x.step / 16) === b).length);
  box.innerHTML = `<span class="muted">小節ごとに採用</span>` + counts.map((c, b) =>
    `<button data-bar="${b}" ${c ? "" : "disabled"}>${b + 1}小節目${c ? `（${c}音）` : ""}</button>`).join("");
  for (const b of box.querySelectorAll<HTMLButtonElement>("[data-bar]")) b.onclick = () => acceptBar(Number(b.dataset.bar));
}

function acceptAll() {
  const g = project.tracks[roll.track].ghost;
  if (!g) return;
  for (const n of [...g.notes]) onEdit("accept", roll.track, n);
}
function closeGhost(keepReason: boolean) {
  const t = project.tracks[roll.track];
  if (!t.ghost) return;
  const entry = project.log[t.ghost.logIndex];
  const alts = t.alts ?? [t.ghost];
  entry.chosen = alts.filter((g) => g.accepted > 0).map((g) => g.label).join("+");
  const main = alts.reduce((a, b) => (b.accepted > a.accepted ? b : a));
  entry.spec = main.spec;
  if (keepReason) entry.reason = $<HTMLTextAreaElement>("reason").value.trim();
  $<HTMLTextAreaElement>("reason").value = "";
  t.ghost = null;
  t.alts = null;
  engine.setLyria(null);
  setStatus("");
  commit();
}

function renderSpec(spec: LyriaSpec) {
  $("spec").innerHTML = `<div class="prompts">${spec.prompts.map((p) => `<code>${esc(p.text)}</code>`).join("")}</div>
  <div class="params">density ${spec.density.toFixed(2)} ・ brightness ${spec.brightness.toFixed(2)} ・ guidance ${spec.guidance.toFixed(1)}</div>
  <p>${esc(spec.rationale)}</p>`;
}
function renderGhostPanel() {
  const t = project.tracks[roll.track];
  const g = t.ghost;
  const panel = $("ghost");
  panel.hidden = !g;
  if (!g) return;
  const alts = t.alts ?? [g];
  $("alts").innerHTML = alts.map((a, k) =>
    `<button data-alt="${k}" aria-pressed="${a === g}"><b>案${a.label}</b> ${esc(a.spec.title ?? "")}${a.accepted ? ` <span class="badge">採用 ${a.accepted}</span>` : ""}</button>`,
  ).join("") + (alts.length < 2 && askBtn.disabled ? `<span class="muted">案Bを準備中…</span>` : "");
  for (const b of $("alts").querySelectorAll<HTMLButtonElement>("[data-alt]")) b.onclick = () => showAlt(t.id, Number(b.dataset.alt));
  renderSpec(g.spec);
  sens.value = String(Math.round((t.id === "drums" ? g.ampRatio : 1 - g.ampRatio) * 100));
  const sure = g.conf.filter((c) => c > 0.6).length;
  $("ghostSummary").textContent = `残り ${g.notes.length} 音（実線で描いた確からしい音 ${sure}、点線は誤検出の可能性あり）。この案から採用 ${g.accepted} 音`;
  $("explain").textContent = g.explanation || "説明を作っています…";
}

function renderLog() {
  const box = $("log");
  if (!project.log.length) { box.innerHTML = `<p class="muted">まだ記録はありません。提案を受け取って「理由を残して閉じる」と、ここに残ります。</p>`; return; }
  box.innerHTML = [...project.log].reverse().map((e) => `<li><div><b>${project.tracks[e.track]?.name ?? e.track}</b> ・ ${new Date(e.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ・ 提案 ${e.proposed} 音中 ${e.accepted} 音を採用</div>
  <div class="intent">意図: ${esc(e.intent)}</div>${e.titles ? `<div class="intent">比べた案: ${e.titles.map(esc).join(" ／ ")}${e.chosen ? `（採用: 案${esc(e.chosen)}）` : ""}</div>` : ""}${e.reason ? `<div class="reason">理由: ${esc(e.reason)}</div>` : ""}</li>`).join("");
}

const sens = $<HTMLInputElement>("sens");
sens.oninput = () => reclean(1 - Number(sens.value) / 100);
$("nudgeL").onclick = () => nudge(-1);
$("nudgeR").onclick = () => nudge(1);
$("acceptAll").onclick = acceptAll;
$("discard").onclick = () => closeGhost(false);
$("close").onclick = () => closeGhost(true);

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea, select")) return;
  if (e.key === "Tab" && project.tracks[roll.track].ghost) { e.preventDefault(); acceptAll(); }
  else if (e.key === "Escape") closeGhost(false);
  else if ((e.key === "1" || e.key === "2") && project.tracks[roll.track].alts) showAlt(roll.track, Number(e.key) - 1);
  else if (e.key === " ") { e.preventDefault(); playBtn.click(); }
});

function setStatus(s: string, error = false) {
  statusEl.textContent = s;
  statusEl.classList.toggle("error", error);
}
function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function confirmInline(btn: HTMLElement, msg: string) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.title = ""; return true; }
  btn.dataset.armed = "1";
  setStatus(msg);
  setTimeout(() => delete btn.dataset.armed, 3000);
  return false;
}

function renderAll() {
  renderTracks();
  renderBarAccept();
  renderGhostPanel();
  renderLog();
  renderModes();
  $("rollTitle").textContent = project.tracks[roll.track].name;
  roll.draw();
}
function commit() {
  save(project);
  renderAll();
}
renderAll();

// ページを開いたら、空いた時間に耳コピのモデルを読み込んでおく
const idle = (cb: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
idle(() => void warmUp());
