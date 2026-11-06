import "./style.css";
import { Engine, PRESETS, renderMix } from "./audio";
import { downloadBytes, encodeWav } from "./wav";
import { cleanToGhost, estimateKey, NOTE_NAMES } from "./core/clean.js";
import { downloadMidi, toMidiFile } from "./core/midi.js";
import { explainGhost, intentToSpecs } from "./gemini";
import { buildClipPrompt, generate, generateClip, serverConfig, slice, type ClipModel } from "./lyria";
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
  stopPreview();
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
    const presets = t.id === "drums" ? null : PRESETS[t.id];
    const presetSel = presets
      ? `<select class="preset" aria-label="${t.name} の音色">${presets.map((p) => `<option value="${p.id}" ${p.id === (t.preset ?? presets[0].id) ? "selected" : ""}>${p.name}</option>`).join("")}</select>`
      : "";
    row.innerHTML = `<button class="track-name">${t.name}</button>${g}<span class="count">${t.notes.length}音</span>${presetSel}
      <input class="vol" type="range" min="-24" max="6" step="1" value="${t.volume ?? 0}" aria-label="${t.name} の音量" title="音量 ${t.volume ?? 0} dB" />
      <button class="solo" aria-pressed="${!!t.solo}" title="ソロ">S</button><button class="mute" aria-pressed="${t.mute}" title="ミュート">M</button>`;
    row.querySelector<HTMLButtonElement>(".track-name")!.onclick = () => { roll.track = t.id; targetSel.value = t.id; renderAll(); };
    row.querySelector<HTMLButtonElement>(".mute")!.onclick = () => { t.mute = !t.mute; commit(); };
    row.querySelector<HTMLButtonElement>(".solo")!.onclick = () => { t.solo = !t.solo; commit(); };
    const vol = row.querySelector<HTMLInputElement>(".vol")!;
    vol.oninput = () => { t.volume = Number(vol.value); vol.title = `音量 ${t.volume} dB`; engine.applyTrackSettings(); };
    vol.onchange = () => commit();
    const ps = row.querySelector<HTMLSelectElement>(".preset");
    if (ps) ps.onchange = () => { t.preset = ps.value; commit(); };
    box.appendChild(row);
  }
}

export type EditKind = "add" | "remove" | "accept" | "reject" | "move" | "resize";

function onEdit(kind: EditKind, id: TrackId, n: Note, next?: Note) {
  const t = project.tracks[id];
  if ((kind === "move" || kind === "resize") && next) {
    // ノートを動かす・長さを変える。重なった同じ楽器（ドラム以外は同じトラック）の音は消す
    const steps = project.bars * 16;
    const m: Note = {
      ...next,
      step: Math.max(0, Math.min(steps - 1, Math.round(next.step))),
      len: Math.max(1, Math.min(steps - Math.max(0, Math.round(next.step)), Math.round(next.len))),
    };
    const others = t.notes.filter((x) => x !== n);
    t.notes = others.filter((x) => !(x.step < m.step + m.len && m.step < x.step + x.len && (id !== "drums" ? true : x.pitch === m.pitch)));
    t.notes.push(m);
    commit();
    return;
  }
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
const modelSel = $<HTMLSelectElement>("model");
const MODEL_KEY = "ghostnotes.model";
modelSel.value = safeGet(MODEL_KEY) ?? "lyria-3.5";
const MODEL_HINTS: Record<string, string> = {
  "lyria-3.5": "最上位のモデル。テンポとキーは指定どおりにならないことがあるので、耳コピのあとで曲に合わせて移調・テンポ合わせをする。約2分かかる",
  "lyria-3-clip-preview": "30秒までの短い曲を作るモデル。3.5 よりテンポとキーを守りやすい",
  realtime: "テンポとキーを設定値で指定でき、指定どおりに演奏する。音質は 3.5 に劣る。約50秒",
};
const showModelHint = () => { $("modelHint").textContent = MODEL_HINTS[modelSel.value] ?? ""; };
showModelHint();
// 中継サーバーが Vertex を使うときは 3.5 の代わりに 3 Pro になり、AI Studio のキーがなければ RealTime は使えない
void serverConfig().then((c) => {
  if (!c) return;
  const opt35 = modelSel.querySelector<HTMLOptionElement>('option[value="lyria-3.5"]')!;
  if (c.musicModels["lyria-3.5"] === "lyria-3-pro-preview") {
    opt35.textContent = "Lyria 3 Pro（音質重視・Vertex）";
    MODEL_HINTS["lyria-3.5"] = "Vertex AI の Lyria 3 Pro。テンポとキーは指定どおりにならないことがあるので、耳コピのあとで曲に合わせる";
  }
  const rt = modelSel.querySelector<HTMLOptionElement>('option[value="realtime"]')!;
  rt.disabled = !c.realtime;
  if (!c.realtime && modelSel.value === "realtime") modelSel.value = "lyria-3.5";
  showModelHint();
});
modelSel.onchange = () => { safeSet(MODEL_KEY, modelSel.value); showModelHint(); };

/** 曲のキーを、ベースとリードの音から「A minor」のような名前にする（Lyria 3.5 へのプロンプト用） */
function projectKeyName(): string {
  const notes = [...project.tracks.bass.notes, ...project.tracks.lead.notes];
  const root = NOTE_NAMES.indexOf(project.root);
  if (notes.length < 4) return `${project.root} major`;
  const k = estimateKey(notes);
  // 推定した相対長調が曲の設定と違うときは、設定のほうを信じて長調として伝える
  if (k.root !== root) return `${project.root} major`;
  return k.mode === "minor" ? `${NOTE_NAMES[k.tonic]} minor` : `${project.root} major`;
}

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
    // ドラムの検出は曲のテンポで格子に合わせる前提なので、テンポを守る RealTime を使う
    const model = target === "drums" ? "realtime" : modelSel.value;
    if (model === "realtime" && modelSel.querySelector<HTMLOptionElement>('option[value="realtime"]')!.disabled) {
      throw new Error("Lyria RealTime が使えない設定です（中継サーバーに AI Studio のキーがない）。ドラムの提案は RealTime が必要です");
    }
    let fulls: AudioBuffer[];
    if (model === "realtime") {
      const prog = specs.map(() => 0);
      const showProg = () => setStatus(`2/4 Lyria RealTime が${specs.length}案を同時に演奏しています… ${Math.min(...prog).toFixed(0)} / ${seconds.toFixed(0)} 秒`);
      showProg();
      // 2案を同時に生成する。生成中の試聴は案Aだけ鳴らす
      fulls = await Promise.all(specs.map((spec, k) =>
        generate(apiKey, {
          role: target, spec, bpm: project.bpm, root: project.root, seconds,
          ctx: engine.context, monitor: monitorChk.checked && k === 0,
          onProgress: (sec) => { prog[k] = sec; showProg(); },
        }),
      ));
    } else {
      const label = model === "lyria-3.5" ? "Lyria 3.5" : "Lyria 3 Clip";
      setStatus(`2/4 ${label} が${specs.length}案を作曲しています（20秒ほどかかります）`);
      const keyName = projectKeyName();
      const clipSec = Math.ceil(seconds + barSec * 2);
      const res = await Promise.all(specs.map((spec) =>
        generateClip(apiKey, { model: model as ClipModel, ctx: engine.context, prompt: buildClipPrompt(spec, { bpm: project.bpm, keyName, role: target, seconds: clipSec }) }),
      ));
      fulls = res.map((r) => r.buffer);
      console.info("作曲に使ったモデル:", res.map((r) => r.model));
      // 耳コピには1分以上かかるので、その間に案A の原音を流しておく（最大30秒、途中で再生を始めたら止める）
      if (monitorChk.checked) previewWhileWaiting(fulls[0]);
      if (res.some((r) => /\[[^\]]*\]\s*[^\[\s]/.test(r.text.replace(/\[\[[^\]]*\]\]/g, "")))) console.warn("歌詞らしきテキストが返った:", res.map((r) => r.text));
    }

    project.log.push({
      at: new Date().toISOString(), track: target, intent, spec: specs[0], proposed: 0, accepted: 0, reason: "",
      titles: specs.map((sp, k) => `${LABELS[k]}: ${sp.title ?? ""}`),
      model: model === "realtime" ? "Lyria RealTime" : model === "lyria-3.5" ? "Lyria 3.5" : "Lyria 3 Clip",
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
        // 非リアルタイムのモデルは1分ほどの曲を返すので、耳コピは先頭の約35秒だけにする（時間を抑えるため）
        const src = model === "realtime" ? fulls[k] : slice(engine.context, fulls[k], 0, Math.min(fulls[k].duration, 35));
        const raw = await transcribe(src, (p) => setStatus(`3/4 案${LABELS[k]}を耳コピしています（basic-pitch） ${Math.round(p * 100)}%`));
        g = makeGhost(target, intent, specs[k], fulls[k], raw, logIndex, k, undefined, model !== "realtime");
        g.model = model;
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

let preview: AudioBufferSourceNode | null = null;
function previewWhileWaiting(buf: AudioBuffer) {
  stopPreview();
  const ctx = engine.context;
  void ctx.resume();
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = 0.7;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.start(ctx.currentTime + 0.05, 0, Math.min(30, buf.duration));
  src.onended = () => { if (preview === src) preview = null; };
  preview = src;
}
function stopPreview() {
  try { preview?.stop(); } catch {}
  preview = null;
}

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
  fixed?: { startSec: number; sourceBpm: number; transpose?: number },
  conform = false,
): Ghost {
  const res = cleanToGhost(raw, { bpm: project.bpm, root: project.root, role: target, bars: project.bars, conform, ...(fixed ?? {}) });
  const dk = res.detectedKey as { tonic: number; mode: string } | null;
  return {
    notes: res.notes, conf: confidence(res.notes, project.bars * 16), full, startSec: res.startSec, sourceBpm: res.sourceBpm, raw, ampRatio: 0.35,
    transpose: res.transpose, detectedKey: dk ? `${NOTE_NAMES[dk.tonic]} ${dk.mode === "minor" ? "マイナー" : "メジャー"}` : undefined,
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
  const bytes = encodeWav(buf);
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
  engine.setLyria(slice(engine.context, g.full, g.startSec, sec), project.bpm / g.sourceBpm, g.transpose ?? 0);
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
  const res = cleanToGhost(g.raw, { bpm: project.bpm, root: project.root, role: id, bars: project.bars, startSec: g.startSec, sourceBpm: g.sourceBpm, transpose: g.transpose ?? 0, ampRatio });
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
  if (g.model && g.model !== "realtime") {
    const tp = g.transpose ?? 0;
    $("spec").insertAdjacentHTML("beforeend", `<div class="params">演奏は ${g.sourceBpm.toFixed(1)} BPM・${esc(g.detectedKey ?? "キー不明")}。${tp ? `曲のキーに合わせて ${tp > 0 ? "+" : ""}${tp} 半音移調し、` : ""}テンポを曲に揃えました</div>`);
  }
  sens.value = String(Math.round((t.id === "drums" ? g.ampRatio : 1 - g.ampRatio) * 100));
  const sure = g.conf.filter((c) => c > 0.6).length;
  $("ghostSummary").textContent = `残り ${g.notes.length} 音（実線で描いた確からしい音 ${sure}、点線は誤検出の可能性あり）。この案から採用 ${g.accepted} 音`;
  $("explain").textContent = g.explanation || "説明を作っています…";
}

function renderLog() {
  const box = $("log");
  if (!project.log.length) { box.innerHTML = `<p class="muted">まだ記録はありません。提案を受け取って「理由を残して閉じる」と、ここに残ります。</p>`; return; }
  box.innerHTML = [...project.log].reverse().map((e) => `<li><div><b>${project.tracks[e.track]?.name ?? e.track}</b> ・ ${new Date(e.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ・ 提案 ${e.proposed} 音中 ${e.accepted} 音を採用</div>
  <div class="intent">意図: ${esc(e.intent)}${e.model ? `（${esc(e.model)}）` : ""}</div>${e.titles ? `<div class="intent">比べた案: ${e.titles.map(esc).join(" ／ ")}${e.chosen ? `（採用: 案${esc(e.chosen)}）` : ""}</div>` : ""}${e.reason ? `<div class="reason">理由: ${esc(e.reason)}</div>` : ""}</li>`).join("");
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
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
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
  recordHistory();
  save(project);
  engine.applyTrackSettings();
  renderAll();
}

// ---------- 元に戻す／やり直す ----------
// 記録するのは曲の中身（ノート、テンポ、キー、音色、音量など）。ゴーストと判断の記録は対象にしない
const history: string[] = [];
let historyIndex = -1;
function snapshot(): string {
  return JSON.stringify({
    bpm: project.bpm, root: project.root, bars: project.bars,
    tracks: Object.fromEntries(Object.values(project.tracks).map((t) => [t.id, { notes: t.notes, mute: t.mute, solo: t.solo, volume: t.volume, preset: t.preset }])),
  });
}
function recordHistory() {
  const s = snapshot();
  if (history[historyIndex] === s) return;
  history.splice(historyIndex + 1);
  history.push(s);
  if (history.length > 200) history.shift();
  historyIndex = history.length - 1;
  renderHistoryButtons();
}
function restore(s: string) {
  const o = JSON.parse(s);
  project.bpm = o.bpm; project.root = o.root; project.bars = o.bars;
  for (const [id, t] of Object.entries(o.tracks) as [TrackId, Partial<typeof project.tracks.lead>][]) Object.assign(project.tracks[id], t);
  bpmInput.value = String(project.bpm);
  keySel.value = project.root;
  engine.setBpm(project.bpm);
  save(project);
  engine.applyTrackSettings();
  renderAll();
  renderHistoryButtons();
}
function undo() { if (historyIndex > 0) restore(history[--historyIndex]); }
function redo() { if (historyIndex < history.length - 1) restore(history[++historyIndex]); }
function renderHistoryButtons() {
  $<HTMLButtonElement>("undo").disabled = historyIndex <= 0;
  $<HTMLButtonElement>("redo").disabled = historyIndex >= history.length - 1;
}
$("undo").onclick = undo;
$("redo").onclick = redo;

$("exportWav").onclick = async () => {
  const btn = $<HTMLButtonElement>("exportWav");
  btn.disabled = true;
  setStatus("採用済みの音を WAV に書き出しています（2ループ）");
  try {
    const buf = await renderMix(project, 2);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    downloadBytes(encodeWav(buf), `ghostnotes-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.wav`, "audio/wav");
    setStatus(`WAV に書き出しました（${buf.duration.toFixed(1)} 秒、ゴーストは含みません）`);
  } catch (e) {
    setStatus(`WAV に書き出せませんでした: ${(e as Error).message}`, true);
  } finally {
    btn.disabled = false;
  }
};
recordHistory();
renderAll();

// ページを開いたら、空いた時間に耳コピのモデルを読み込んでおく
const idle = (cb: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
idle(() => void warmUp());
