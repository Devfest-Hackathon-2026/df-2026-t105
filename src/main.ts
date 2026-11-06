import "./style.css";
import { Engine } from "./audio";
import { cleanToGhost, NOTE_NAMES } from "./core/clean.js";
import { explainGhost, intentToSpec } from "./gemini";
import { generate, slice } from "./lyria";
import { Roll } from "./roll";
import { demoProject, load, save, type Ghost, type LyriaSpec, type Note, type Project, type TrackId } from "./state";
import { transcribe } from "./transcribe";

let project: Project = load() ?? demoProject();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const engine = new Engine(() => project);
const roll = new Roll($("roll"), () => project, onEdit);
engine.onStep = (s) => { roll.playStep = s; roll.draw(); };

// ---------- API キー ----------
const KEY_STORE = "ghostnotes.apiKey";
const apiKeyInput = $<HTMLInputElement>("apiKey");
apiKeyInput.value = safeGet(KEY_STORE) ?? (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? "";
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
    row.querySelector<HTMLButtonElement>(".track-name")!.onclick = () => { roll.track = t.id; targetSel.value = t.id === "drums" ? targetSel.value : t.id; renderAll(); };
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
      t.notes = t.notes.filter((x) => !(x.step < n.step + n.len && n.step < x.step + x.len));
      t.notes.push(n);
      project.log[t.ghost.logIndex].accepted++;
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

askBtn.onclick = async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { setStatus("右上に Gemini API キーを入れてください", true); apiKeyInput.focus(); return; }
  const target = targetSel.value as "lead" | "bass";
  const intent = intentInput.value.trim() || "この曲に合うシンプルなフレーズ";
  askBtn.disabled = true;
  try {
    setStatus("1/4 意図を Lyria への指示に変換しています（Gemini）");
    let spec: LyriaSpec;
    try {
      spec = await intentToSpec(apiKey, project, target, intent);
    } catch (e) {
      console.warn(e);
      spec = { prompts: [{ text: target === "bass" ? "solo synth bass, single notes, dry" : "monophonic synth lead, single notes, dry, no chords", weight: 1 }], density: 0.4, brightness: 0.5, guidance: 4.5, rationale: "（Gemini に繋がらなかったので既定の指示で生成しました）" };
    }
    renderSpec(spec);

    const barSec = (60 / project.bpm) * 4;
    const seconds = 2 + barSec * (project.bars + 1);
    setStatus(`2/4 Lyria が演奏しています… 0 / ${seconds.toFixed(0)} 秒`);
    const full = await generate(apiKey, {
      role: target, spec, bpm: project.bpm, root: project.root, seconds,
      ctx: engine.context, monitor: monitorChk.checked,
      onProgress: (s) => setStatus(`2/4 Lyria が演奏しています… ${s.toFixed(0)} / ${seconds.toFixed(0)} 秒`),
    });

    setStatus("3/4 演奏を耳コピしています（basic-pitch）");
    const raw = await transcribe(full, (p) => setStatus(`3/4 演奏を耳コピしています（basic-pitch） ${Math.round(p * 100)}%`));
    const res = cleanToGhost(raw, { bpm: project.bpm, root: project.root, role: target, bars: project.bars });
    if (!res.notes.length) throw new Error("音を拾えませんでした。もう一度試すか、意図の書き方を変えてください");

    project.log.push({ at: new Date().toISOString(), track: target, intent, spec, proposed: res.notes.length, accepted: 0, reason: "" });
    const ghost: Ghost = {
      notes: res.notes, conf: confidence(res.notes, project.bars * 16), full, startSec: res.startSec, raw, ampRatio: 0.35,
      spec, intent, explanation: "", logIndex: project.log.length - 1,
    };
    project.tracks[target].ghost = ghost;
    roll.track = target;
    applyLyriaSlice(ghost);
    commit();
    setStatus(`提案が届きました。生の音 ${raw.length} 個から ${res.notes.length} 音に整理しました。4/4 説明を作っています…`);
    ghost.explanation = await explainGhost(apiKey, project, target, ghost.notes, intent).catch(() => "（説明を取得できませんでした）");
    renderGhostPanel();
    setStatus(`提案 ${res.notes.length} 音。クリックで1音ずつ採用、右クリックで消去、Tab で全部採用`);
  } catch (e) {
    console.error(e);
    setStatus(String((e as Error).message ?? e), true);
  } finally {
    askBtn.disabled = false;
  }
};

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

function applyLyriaSlice(g: Ghost) {
  const sec = (60 / project.bpm) * 4 * project.bars;
  engine.setLyria(slice(engine.context, g.full, g.startSec, sec));
}

function nudge(d: number) {
  const id = roll.track;
  const g = project.tracks[id].ghost;
  if (!g) return;
  const steps = project.bars * 16;
  for (const n of g.notes) n.step = (n.step + d + steps) % steps;
  g.notes.sort((a, b) => a.step - b.step);
  g.conf = confidence(g.notes, steps);
  g.startSec -= d * (60 / project.bpm / 4);
  applyLyriaSlice(g);
  commit();
}
/** 拾う音の量を変えて、生成し直さずに整形だけやり直す */
function reclean(ampRatio: number) {
  const id = roll.track;
  const g = project.tracks[id].ghost;
  if (!g || id === "drums") return;
  g.ampRatio = ampRatio;
  const res = cleanToGhost(g.raw, { bpm: project.bpm, root: project.root, role: id, bars: project.bars, startSec: g.startSec, ampRatio });
  g.notes = res.notes;
  g.conf = confidence(g.notes, project.bars * 16);
  commit();
}

function acceptAll() {
  const g = project.tracks[roll.track].ghost;
  if (!g) return;
  for (const n of [...g.notes]) onEdit("accept", roll.track, n);
}
function closeGhost(keepReason: boolean) {
  const t = project.tracks[roll.track];
  if (!t.ghost) return;
  if (keepReason) project.log[t.ghost.logIndex].reason = $<HTMLTextAreaElement>("reason").value.trim();
  t.ghost = null;
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
  const g = project.tracks[roll.track].ghost;
  const panel = $("ghost");
  panel.hidden = !g;
  if (!g) return;
  renderSpec(g.spec);
  sens.value = String(Math.round((1 - g.ampRatio) * 100));
  const sure = g.conf.filter((c) => c > 0.6).length;
  $("ghostSummary").textContent = `残り ${g.notes.length} 音（実線で描いた確からしい音 ${sure}、点線は誤検出の可能性あり）。採用 ${project.log[g.logIndex].accepted} 音`;
  $("explain").textContent = g.explanation || "説明を作っています…";
}

function renderLog() {
  const box = $("log");
  if (!project.log.length) { box.innerHTML = `<p class="muted">まだ記録はありません。提案を受け取って「理由を残して閉じる」と、ここに残ります。</p>`; return; }
  box.innerHTML = [...project.log].reverse().map((e) => `<li><div><b>${e.track === "bass" ? "Bass" : "Lead"}</b> ・ ${new Date(e.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ・ 提案 ${e.proposed} 音中 ${e.accepted} 音を採用</div>
  <div class="intent">意図: ${esc(e.intent)}</div>${e.reason ? `<div class="reason">理由: ${esc(e.reason)}</div>` : ""}</li>`).join("");
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
