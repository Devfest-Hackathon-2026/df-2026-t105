import { selectAlignedWindow } from "./core/alignment.js";
import { mapConcurrent } from "./core/concurrency.js";
import { notesToParts } from "./core/parts.js";
import { SOUNDFONT_PRESETS, findSoundFontPreset, midiProgram, normalizePresetId, shortPresetName } from "./soundfont";
import "./style.css";
import { Engine, renderMix } from "./audio";
import { downloadBytes, encodeWav } from "./wav";
import { cleanToGhost, estimateKey, NOTE_NAMES } from "./core/clean.js";
import { downloadMidi, toMidiFile } from "./core/midi.js";
import { intentToSpecs } from "./gemini";
import { buildClipPrompt, generate, generateClip, serverConfig, slice, type ClipModel } from "./lyria";
import { KEY_W, Roll } from "./roll";
import { VelocityLane } from "./velocity";
import { contentBars, demoProject, describeForLyria, load, save, trackRole, type Ghost, type LyriaSpec, type Note, type Project, type TrackId } from "./state";
import { toMono22k, transcribe, warmUp } from "./transcribe";
import { estimateStartSec, transcribeDrums } from "./core/drums.js";
import { drumsToGhost, transcribeWithMuscriptor, transcribeWithMuscriptorDetailed } from "./muscriptor";

let project: Project = load() ?? demoProject();
project.bars=contentBars(project);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const engine = new Engine(() => project);
const roll = new Roll($("roll"), () => project, onEdit);
if(!project.tracks[roll.track])roll.track=Object.keys(project.tracks)[0] as TrackId;
roll.onAudition = (pitch) => { void engine.audition(roll.track, pitch).catch((e) => setStatus(e.message, true)); };
const vel = new VelocityLane($("vel"), () => project, () => roll.track, (id, n, v) => onEdit("move", id, n, { ...n, vel: v }));
engine.onStep = (s) => {
  const previous=roll.playStep;
  roll.playStep = s;
  if(s>=0&&(s>=(roll.startBar+roll.viewBars)*16||(s<previous&&s<roll.startBar*16))){roll.startBar=Math.floor(s/(roll.viewBars*16))*roll.viewBars;renderAll()}
  else roll.draw();
  $("position").textContent = s < 0 ? "1.1.1" : `${Math.floor(s / 16) + 1}.${Math.floor((s % 16) / 4) + 1}.${(s % 4) + 1}`;
};
// OS のダークモードを切り替えたら、canvas も描き直す
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());

function showMobilePane(pane:string){
  document.querySelector<HTMLElement>(".workspace")!.dataset.mobilePane=pane;
  for(const b of document.querySelectorAll<HTMLButtonElement>("[data-pane]"))b.setAttribute("aria-pressed",String(b.dataset.pane===pane));
  if(pane==="editor")requestAnimationFrame(()=>{roll.draw();vel.draw()});
}
for(const b of document.querySelectorAll<HTMLButtonElement>("[data-pane]"))b.onclick=()=>showMobilePane(b.dataset.pane!);

// ---------- API キー ----------
const KEY_STORE = "ghostnotes.apiKey";
const apiKeyInput = $<HTMLInputElement>("apiKey");
apiKeyInput.value = safeGet(KEY_STORE) ?? "";
apiKeyInput.addEventListener("change", () => safeSet(KEY_STORE, apiKeyInput.value.trim()));
function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }

// ---------- トランスポート ----------
const playBtn = $<HTMLButtonElement>("play");
const loopBtn=$<HTMLButtonElement>("loop");
let loopEnabled=safeGet("ghostnotes.loop")==="true";
function renderLoop(){loopBtn.setAttribute("aria-pressed",String(loopEnabled))}
loopBtn.onclick=()=>{loopEnabled=!loopEnabled;safeSet("ghostnotes.loop",String(loopEnabled));engine.setLoop(loopEnabled);renderLoop()};
renderLoop();
function renderPlay(playing: boolean) {
  playBtn.querySelector("use")!.setAttribute("href", playing ? "#i-stop" : "#i-play");
  playBtn.setAttribute("aria-label", playing ? "停止" : "再生");
  playBtn.setAttribute("aria-pressed", String(playing));
}
playBtn.onclick = async () => {
  const willPlay = !engine.playing;
  stopPreview();
  try {
    if (willPlay) { setStatus("音源を準備しています"); await engine.start(0,project.bars*16,loopEnabled); setStatus(""); }
    else engine.stop();
    renderPlay(willPlay);
  } catch (e) { setStatus((e as Error).message, true); renderPlay(false); }
};
$("toStart").onclick = async () => {
  const was = engine.playing;
  engine.stop();
  if (was) await engine.start(0,project.bars*16,loopEnabled);
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
keySel.innerHTML = NOTE_NAMES.map((n) => `<option value="${n}">${n} / ${NOTE_NAMES[(NOTE_NAMES.indexOf(n) + 9) % 12]}m</option>`).join("");
keySel.value = project.root;
keySel.onchange = () => { project.root = keySel.value; commit(); };
const viewStart=$<HTMLInputElement>("viewStart"),viewBars=$<HTMLSelectElement>("viewBars"),timeline=$<HTMLInputElement>("timeline");
function moveView(bar:number){roll.startBar=Math.max(0,Math.floor(bar)||0);renderAll()}
viewStart.onchange=()=>moveView(Number(viewStart.value)-1);
viewBars.onchange=()=>{roll.viewBars=Number(viewBars.value);renderAll()};
$("playView").onclick=async()=>{stopPreview();engine.stop();try{loopEnabled=true;renderLoop();await engine.start(roll.startBar*16,(roll.startBar+roll.viewBars)*16,true);renderPlay(true)}catch(e){setStatus((e as Error).message,true)}};
$("viewPrev").onclick=()=>moveView(roll.startBar-roll.viewBars);
$("viewNext").onclick=()=>moveView(roll.startBar+roll.viewBars);
timeline.oninput=()=>moveView(Number(timeline.value));
document.querySelector<HTMLElement>(".roll-wrap")!.addEventListener("wheel",e=>{
  if(!e.shiftKey&&Math.abs(e.deltaX)<=Math.abs(e.deltaY))return;
  const delta=e.deltaX||e.deltaY;if(!delta)return;
  e.preventDefault();moveView(roll.startBar+Math.sign(delta)*Math.max(1,Math.round(Math.abs(delta)/80)));
},{passive:false});
$<HTMLSelectElement>("grid").onchange=()=>{roll.snap=Number($<HTMLSelectElement>("grid").value);roll.draw()};
$("reset").onclick = () => {
  if (!confirmInline($("reset"), "もう一度押すと曲を空にします")) return;
  project = demoProject();
  roll.track = "lead";roll.startBar=0;
  for (const t of Object.values(project.tracks)) t.ghost = null;
  engine.setLyria(null);
  bpmInput.value = String(project.bpm);
  keySel.value = project.root;
  engine.setBars(project.bars);
  commit();
};

// 採用済みの音だけを書き出す（ゴーストは含めない）。GM の音色番号: 38 = Synth Bass 1、80 = Lead 1 (square)
$("exportMidi").onclick = () => {
  let melodic = 0;
  const tracks=Object.values(project.tracks).map((t)=>{
    const role=trackRole(project,t.id),index=melodic++,port=Math.floor(index/15),slot=index%15;
    return {name:t.name,port,channel:role==="drums"?9:(slot>=9?slot+1:slot),program:midiProgram(role,t.preset),notes:t.notes};
  });
  const bytes=toMidiFile(tracks,{bpm:project.bpm});
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  downloadMidi(bytes, `ghostnotes-${stamp}.mid`);
  setStatus("MIDI に書き出しました");
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
const PRESET_GROUPS = [...new Set(SOUNDFONT_PRESETS.map((p) => p.group))];
function renderPresetSelect(t: Project["tracks"][string]): string {
  const role = trackRole(project, t.id);
  const currentId = normalizePresetId(role, t.preset);
  const groupsHtml = PRESET_GROUPS.map((group) => {
    const opts = SOUNDFONT_PRESETS.filter((p) => p.group === group)
      .map((p) => `<option value="${p.id}" ${p.id === currentId ? "selected" : ""}>${esc(p.name)}</option>`)
      .join("");
    return `<optgroup label="${esc(group)}">${opts}</optgroup>`;
  }).join("");
  return `<select class="preset" aria-label="${esc(t.name)} の音色 (MuseScore General)">${groupsHtml}</select>`;
}

const DEFAULT_ADD_PRESETS = ["sf:0", "sf:33", "drum:0", "sf:73", "sf:48", "sf:24", "sf:56", "sf:80"];
$("addTrack").onclick = () => {
  const used = new Set(Object.values(project.tracks).map((t) => normalizePresetId(trackRole(project, t.id), t.preset)));
  const presetId = DEFAULT_ADD_PRESETS.find((id) => !used.has(id)) ?? "sf:0";
  const preset = findSoundFontPreset("lead", presetId);
  const baseName = shortPresetName(preset);
  const existingNames = new Set(Object.values(project.tracks).map((t) => t.name));
  let name = baseName;
  for (let i = 2; existingNames.has(name); i++) name = `${baseName} ${i}`;
  const id: TrackId = `track:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  project.tracks[id] = {
    id,
    name,
    role: preset.role,
    instrument: preset.instrument,
    preset: preset.id,
    polyphonic: true,
    notes: [],
    mute: false,
    ghost: null,
  };
  roll.track = id;
  targetSel.value = id;
  commit();
};

function renderTracks() {
  const box = $("tracks");
  const targetControl=$<HTMLSelectElement>("target");const selectedTarget=targetControl.value;
  targetControl.innerHTML=Object.values(project.tracks).map((t)=>`<option value="${t.id}">${esc(t.name)}</option>`).join("");
  targetControl.value=project.tracks[selectedTarget as TrackId]?selectedTarget:Object.keys(project.tracks)[0];
  box.innerHTML = "";
  const canDelete = Object.keys(project.tracks).length > 1;
  for (const t of Object.values(project.tracks)) {
    const role = trackRole(project, t.id);
    t.preset = normalizePresetId(role, t.preset);
    const row = document.createElement("div");
    row.className = "track" + (roll.track === t.id ? " selected" : "");
    row.style.setProperty("--tc", `var(--track-${role})`);
    const presetSel = renderPresetSelect(t);
    const ghost = t.ghost ? `<span class="ghost-badge" title="提案があります" aria-label="提案あり"></span>` : "";
    const delBtn = canDelete ? `<button class="track-del" aria-label="${esc(t.name)}を削除" title="${esc(t.name)}を削除">×</button>` : "";
    row.innerHTML = `<span class="dot"></span>
      <button class="track-name" title="${esc(t.name)} をエディタで開く">${esc(t.name)}<span class="count">${t.notes.length}音</span>${ghost}</button>
      <button class="solo" aria-label="${esc(t.name)}をソロ" aria-pressed="${!!t.solo}" title="ソロ（このトラックだけ鳴らす）">S</button>
      <button class="mute" aria-label="${esc(t.name)}をミュート" aria-pressed="${t.mute}" title="ミュート">M</button>
      ${delBtn}
      <canvas class="clip" aria-hidden="true"></canvas>
      <input class="vol" type="range" min="-24" max="6" step="1" value="${t.volume ?? 0}" aria-label="${esc(t.name)} の音量" title="音量 ${t.volume ?? 0} dB" />
      ${presetSel}`;
    const select = () => { showMobilePane("editor");roll.track = t.id; targetSel.value = t.id; renderAll(); };
    row.querySelector<HTMLButtonElement>(".track-name")!.onclick = select;
    row.querySelector<HTMLCanvasElement>(".clip")!.onclick = select;
    row.querySelector<HTMLButtonElement>(".mute")!.onclick = () => { t.mute = !t.mute; commit(); };
    row.querySelector<HTMLButtonElement>(".solo")!.onclick = () => { t.solo = !t.solo; commit(); };
    const del = row.querySelector<HTMLButtonElement>(".track-del");
    if (del) {
      del.onclick = () => {
        if (Object.keys(project.tracks).length <= 1) return;
        delete project.tracks[t.id];
        delete comps[t.id];
        if (!project.tracks[roll.track]) roll.track = Object.keys(project.tracks)[0] as TrackId;
        commit();
      };
    }
    const volIn = row.querySelector<HTMLInputElement>(".vol")!;
    volIn.oninput = () => { t.volume = Number(volIn.value); volIn.title = `音量 ${t.volume} dB`; engine.applyTrackSettings(); };
    volIn.onchange = () => commit();
    const ps = row.querySelector<HTMLSelectElement>("select.preset")!;
    ps.onchange = () => {
      const prevPreset = findSoundFontPreset(role, t.preset);
      const nextPreset = findSoundFontPreset(role, ps.value);
      const prevShort = shortPresetName(prevPreset);
      if (t.name === prevShort || t.name === prevPreset.name || ["生成先", "Lead", "Bass", "Drums", "ドラム"].includes(t.name)) {
        t.name = shortPresetName(nextPreset);
      }
      t.preset = nextPreset.id;
      t.role = nextPreset.role;
      t.instrument = nextPreset.instrument;
      t.polyphonic = true;
      commit();
    };
    box.appendChild(row);
    drawClip(row.querySelector<HTMLCanvasElement>(".clip")!, t.id);
  }
}

/** トラック一覧の小さなクリップ表示（アレンジ画面のクリップの代わり）。ループ全体の音を縮めて描く */
function drawClip(cv: HTMLCanvasElement, id: TrackId) {
  const r = cv.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const c = cv.getContext("2d")!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const t = project.tracks[id];
  const steps = project.bars * 16;
  const notes = [...t.notes, ...(t.ghost?.notes ?? [])];
  if (!notes.length) return;
  const ps = notes.map((n) => n.pitch);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const span = Math.max(6, hi - lo + 1);
  const cw = r.width / steps, rh = (r.height - 6) / span;
  c.fillStyle = v("--line");
  for (let b = 1; cw*16>=4 && b < project.bars; b++) c.fillRect(Math.round(b * 16 * cw), 0, 1, r.height);
  const draw = (n: Note, color: string, a: number) => {
    c.globalAlpha = a;
    c.fillStyle = color;
    c.fillRect(n.step * cw, 3 + (hi - n.pitch) * rh, Math.max(1.5, n.len * cw - 0.5), Math.max(1.5, rh));
  };
  for (const n of t.ghost?.notes ?? []) draw(n, v("--ghost"), 0.45);
  for (const n of t.notes) draw(n, v(`--track-${trackRole(project,id)}`), 1);
  c.globalAlpha = 1;
}

function noteConflicts(id:TrackId,a:Note,b:Note){
  const t=project.tracks[id];
  if(t.polyphonic||trackRole(project,id)==="drums")return a.pitch===b.pitch&&Math.abs(a.step-b.step)<1e-4;
  return a.step<b.step+b.len&&b.step<a.step+a.len&&((id==="lead"||id==="bass")||a.pitch===b.pitch);
}

export type EditKind = "add" | "remove" | "accept" | "reject" | "move" | "resize";

function onEdit(kind: EditKind, id: TrackId, n: Note, next?: Note) {
  const t = project.tracks[id];
  if ((kind === "move" || kind === "resize") && next) {
    // 移動・リサイズでも細かい発音時刻を保持する。
    const m: Note = {
      ...next,
      step: Math.max(0,next.step),
      len: Math.max(1/960,next.len),
    };
    const others = t.notes.filter((x) => x !== n);
    t.notes = others.filter((x) => !noteConflicts(id,x,m));
    t.notes.push(m);
    commit();
    return;
  }
  if (kind === "add") {
    if ((id === "lead" || id === "bass") && !t.polyphonic) t.notes = t.notes.filter((x) => !(x.step < n.step + n.len && n.step < x.step + x.len));
    t.notes.push(n);
  } else if (kind === "remove") t.notes = t.notes.filter((x) => x !== n);
  else if (t.ghost) {
    const i = t.ghost.notes.indexOf(n);
    t.ghost.notes.splice(i, 1);
    t.ghost.conf.splice(i, 1);
    if (kind === "accept") {
      // 既存の同位置・同音だけを置換し、重なった連打の発音は残す。
      t.notes = t.notes.filter((x) => !noteConflicts(id,x,n));
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
// 中継サーバーが Vertex を使うときは 3.5 の代わりに 3 Pro になり、AI Studio のキーがなければ RealTime は使えない
// サーバー側に muscriptor があれば、ドラムの耳コピに使う（帯域の音量で拾う drums.js より、キックとスネアの取り違えが少ない）
const transcriberSel = $<HTMLSelectElement>("transcriber");
transcriberSel.value = safeGet("ghostnotes.transcriber.v2") ?? "cpu";
transcriberSel.onchange = () => safeSet("ghostnotes.transcriber.v2", transcriberSel.value);
const candidateCount = $<HTMLSelectElement>("candidateCount");
candidateCount.value = safeGet("ghostnotes.candidateCount") ?? "1";
candidateCount.onchange = () => {safeSet("ghostnotes.candidateCount",candidateCount.value);updateConcurrencyChoices()};
const generationConcurrency = $<HTMLSelectElement>("generationConcurrency");
generationConcurrency.value = safeGet("ghostnotes.generationConcurrency") ?? "1";
generationConcurrency.onchange = () => safeSet("ghostnotes.generationConcurrency",generationConcurrency.value);
function updateConcurrencyChoices(){const n=Number(candidateCount.value)||1;for(const o of generationConcurrency.options)o.disabled=Number(o.value)>n;if(Number(generationConcurrency.value)>n)generationConcurrency.value=String(n);generationConcurrency.disabled=n===1}
updateConcurrencyChoices();
let requestedCount = 1;
void serverConfig().then((c) => {
  if (!c) return;
  const available = (c as { transcribers?: { cpu: boolean; a100: boolean }; transcription?: { default: string } });
  for (const backend of ["cpu", "a100"] as const) transcriberSel.querySelector<HTMLOptionElement>(`option[value="${backend}"]`)!.disabled = !available.transcribers?.[backend];
  if (transcriberSel.selectedOptions[0]?.disabled) transcriberSel.value = available.transcription?.default ?? "browser";
  const opt35 = modelSel.querySelector<HTMLOptionElement>('option[value="lyria-3.5"]')!;
  if (c.musicModels["lyria-3.5"] === "lyria-3-pro-preview") opt35.textContent = "Lyria 3 Pro（音質重視・Vertex）";
  const rt = modelSel.querySelector<HTMLOptionElement>('option[value="realtime"]')!;
  rt.disabled = !c.realtime;
  if (!c.realtime && modelSel.value === "realtime") modelSel.value = "lyria-3.5";
});
modelSel.onchange = () => safeSet(MODEL_KEY, modelSel.value);

/** 曲のキーを、ベースとリードの音から「A minor」のような名前にする（Lyria 3.5 へのプロンプト用） */
function projectKeyName(): string {
  const notes = Object.values(project.tracks).filter((t)=>trackRole(project,t.id)!=="drums").flatMap((t)=>t.notes);
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
  const targetId = targetSel.value as TrackId;
  const target = trackRole(project,targetId);
  const model = modelSel.value;
  const generationStart=Math.max(0,Math.floor(Number($<HTMLInputElement>("generationStart").value)||1)-1);
  const generationBars=Math.max(1,Math.min(32,Math.floor(Number($<HTMLInputElement>("generationBars").value)||4)));
  const startStep=generationStart*16;
  const requestProject:Project={...project,bars:generationBars,tracks:Object.fromEntries(Object.values(project.tracks).map(t=>[t.id,{...t,notes:t.notes.filter(n=>n.step>=startStep&&n.step<startStep+generationBars*16).map(n=>({...n,step:n.step-startStep}))}]))};
  const intent = intentInput.value.trim() || "この曲に合うシンプルなフレーズ";
  askBtn.disabled = true;
  requestedCount = Math.min(4,Math.max(1,Number(candidateCount.value)||1));
  const parallelism = Math.min(requestedCount,Math.max(1,Number(generationConcurrency.value)||1));
  stopPreview();
  previewBuffers.clear();$("previewPanel").hidden=true;
  previewAudio.removeAttribute("src");previewAudio.load();
  if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null}
  $("previewStop").setAttribute("disabled","");
  renderPreviewChoices();
  const backend = transcriberSel.value as "browser" | "cpu" | "a100";
  try {
    const capabilities = await serverConfig() as { transcribers?: Record<string,boolean> } | null;
    if (backend !== "browser" && !capabilities?.transcribers?.[backend]) throw new Error("選んだMuScriptorは現在利用できません。設定で採譜先を確認してください");
    setStatus("1/3 意図を解釈しています");
    let specs: LyriaSpec[];
    try {
      specs = await intentToSpecs(apiKey, requestProject, targetId, intent, requestedCount);
    } catch (e) {
      console.warn(e);
      const fallback=FALLBACK(target);
      specs = Array.from({length:requestedCount},(_,k)=>({...fallback[k%fallback.length]}));
    }
    while(specs.length<requestedCount)specs.push(structuredClone(specs[specs.length%Math.max(1,specs.length)]));
    const barSec = (60 / project.bpm) * 4;
    const seconds = 2 + barSec * (generationBars + 1);
    // Lyria は既存トラックの音声を聴けないので、音符の内容を英語の説明にしてプロンプトに添える
    const context = describeForLyria(requestProject, targetId);
    if (model === "realtime" && modelSel.querySelector<HTMLOptionElement>('option[value="realtime"]')!.disabled) {
      throw new Error("Lyria RealTime が使えない設定です（中継サーバーに AI Studio のキーがない）。設定で別のモデルを選んでください");
    }
    let fulls: AudioBuffer[];
    if (model === "realtime") {
      const prog = specs.map(() => 0);
      const showProg = () => setStatus(`2/3 Lyria RealTime が演奏しています ${prog.reduce((sum,n)=>sum+n,0).toFixed(0)} / ${(seconds*specs.length).toFixed(0)} 秒分`);
      showProg();
      // 2案を同時に生成する。生成中の試聴は案Aだけ鳴らす
      fulls = await mapConcurrent(specs,parallelism,async (spec,k) => {
        const full = await generate(apiKey, {
          role: target, spec, bpm: project.bpm, root: project.root, seconds, context,
          ctx: engine.context, monitor: false,
          onProgress: (sec) => { prog[k] = sec; showProg(); },
        });
        setPreviewCandidate(k,full);return full;
      });
    } else {
      const label = model === "lyria-3.5" ? "Lyria 3.5" : "Lyria 3 Clip";
      setStatus(`2/3 ${label} が作曲しています`);
      const keyName = projectKeyName();
      const clipSec = Math.ceil(seconds + barSec * 2);
      const res = await mapConcurrent(specs,parallelism,async (spec,k) => {
        const result=await generateClip(apiKey,{model:model as ClipModel,ctx:engine.context,prompt:buildClipPrompt(spec,{bpm:project.bpm,keyName,role:target,seconds:clipSec,context})});
        setPreviewCandidate(k,slice(engine.context,result.buffer,0,Math.min(result.buffer.duration,clipSec)));return result;
      });
      fulls = res.map((r) => r.buffer);
      console.info("作曲に使ったモデル:", res.map((r) => r.model));
      // 耳コピには1分以上かかるので、その間に案A の原音を流しておく（最大30秒、途中で再生を始めたら止める）

      if (res.some((r) => /\[[^\]]*\]\s*[^\[\s]/.test(r.text.replace(/\[\[[^\]]*\]\]/g, "")))) console.warn("歌詞らしきテキストが返った:", res.map((r) => r.text));
    }

    project.log.push({
      at: new Date().toISOString(), track: targetId, intent, spec: specs[0], proposed: 0, accepted: 0, reason: "",
      titles: specs.map((sp, k) => `${LABELS[k]}: ${sp.title ?? ""}`),
      model: model === "realtime" ? "Lyria RealTime" : model === "lyria-3.5" ? "Lyria 3.5" : "Lyria 3 Clip",
    });
    const logIndex = project.log.length - 1;
    const t = project.tracks[targetId];
    const touched = new Set<TrackId>();
    t.alts = [];
    roll.track = targetId;roll.startBar=generationStart;
    for (let k = 0; k < specs.length; k++) {
      setStatus(`3/3 案${LABELS[k]}を耳コピしています`);
      if(backend !== "browser") {
        const src = slice(engine.context,fulls[k],0,Math.min(fulls[k].duration,Math.max(24,2*generationBars*barSec+8)));
        const transcription = await transcribeWithMuscriptorDetailed(await toMono22k(src),22050,[],backend,(text)=>setStatus(`3/3 ${text}`));
        const hits = transcription.notes;
        if(!hits.length)throw new Error("MuScriptorの採譜結果は0音でした。生成音を確認して再試行してください");
        const raw = hits.map((n)=>({startTimeSeconds:n.start,durationSeconds:n.end-n.start,pitchMidi:n.pitch,amplitude:.8,instrument:n.instrument}));
        const grouped=notesToParts(hits,{bpm:project.bpm,bars:Math.ceil(src.duration*project.bpm/240)+1});
        const candidates=target==="drums"?grouped.filter(p=>p.role==="drums"):grouped.filter(p=>p.role!=="drums");
        const selected=candidates.find(p=>p.instrument===t.instrument)??candidates.find(p=>p.role===target)??candidates[0];
        if(!selected)throw new Error("対象のトラックに対応する音を拾えませんでした。原音を確認してください");
        const primaryHits=hits.filter(n=>n.instrument===selected.instrument);
        const prior=cleanToGhost(raw.filter(n=>n.instrument===selected.instrument),{bpm:project.bpm,root:project.root,role:target==="bass"?"bass":"lead",bars:generationBars,conform:model!=="realtime"});
        const grid=transcription.beatGrid;
        const usableGrid=!!(grid&&Number.isFinite(grid.bpm)&&grid.bpm>0);
        const wantTriplet=/shuffle|シャッフル|swing|スウィング|跳ね|三連|triplet|jazzy|ジャズ|blues|ブルース/i.test(intent+" "+specs[k].prompts.map(p=>p.text).join(" "));
        const clock=selectAlignedWindow(primaryHits,{bpm:usableGrid?grid.bpm:prior.sourceBpm,bars:generationBars,audioDuration:src.duration,firstDownbeat:usableGrid?(grid.first_downbeat??0):prior.phase,onsetDelay:usableGrid?(grid.onset_delay??0):0,beatGrid:usableGrid?grid:null});
        const sub=clock.subdivision??(wantTriplet?6:4);
        const corrected=hits.map(n=>({...n,start:n.start-clock.onsetDelay,end:n.end-clock.onsetDelay}));
        const parts=notesToParts(corrected,{bpm:clock.sourceBpm,bars:generationBars,startSec:clock.startSec,transpose:prior.transpose??0,windowBeats:clock.windowBeats,subdivision:sub,quantizeStrength:0.85});
        if(!parts.length)throw new Error("ループ区間に音符を拾えませんでした");
        const pitched=parts.filter((p)=>p.role!=="drums");
        const primary=target==="drums"?parts.find((p)=>p.role==="drums"):
          pitched.find((p)=>p.instrument===t.instrument)??pitched.find((p)=>p.role===target)??pitched[0];
        if(!primary)throw new Error("対象のトラックに対応する音を拾えませんでした。原音を確認してください");
        for(const part of parts)for(const note of part.notes)note.step+=startStep;
        const alignedSec = Math.max(0.5, (clock.endSec ?? (clock.startSec + (60 / clock.sourceBpm) * 4 * generationBars)) - clock.startSec);
        const g:Ghost={startStep,bars:generationBars,notes:primary.notes,conf:primary.notes.map(()=>.8),polyphonic:true,full:fulls[k],startSec:clock.startSec+clock.onsetDelay,sourceBpm:clock.sourceBpm,transpose:prior.transpose,raw:raw.filter((n)=>n.instrument===primary.instrument),ampRatio:0,spec:specs[k],intent,explanation:"",logIndex,label:LABELS[k],proposed:primary.notes.length,accepted:0,model:"MuScriptor"};
        previewBuffers.set(k, slice(engine.context, fulls[k], g.startSec, alignedSec));
        if (Number(previewTake.value) === k && previewAudio.paused) loadPreview(previewBuffers.get(k)!);
        if (k === 0) {
          const gridSel = $<HTMLSelectElement>("grid");
          if (sub % 3 === 0 || wantTriplet) {
            const tripletVal = sub === 3 ? "1.3333333333333333" : "0.6666666666666666";
            gridSel.value = tripletVal;
            roll.snap = Number(tripletVal);
          } else if (roll.snap === 0.25) {
            gridSel.value = "1";
            roll.snap = 1;
          }
        }
        t.polyphonic=true;t.instrument=primary.instrument;t.role=primary.role;t.name=primary.name;t.preset=primary.role==="drums"?"drum:0":`sf:${primary.program}`;
        t.alts!.push(g);touched.add(targetId);
        for(const part of parts.filter(p=>p!==primary&&(target!=="drums"&&p.notes.length>=3))) {
          const id:TrackId=Object.values(project.tracks).find(track=>track.id!==targetId&&track.instrument===part.instrument)?.id??`part:${part.instrument}`;
          const track=project.tracks[id]??={id,name:part.name,role:part.role,instrument:part.instrument,preset:part.role==="drums"?"drum:0":`sf:${part.program}`,polyphonic:true,notes:[],mute:false,ghost:null};
          if(!touched.has(id))track.alts=[];
          const other:Ghost={...g,notes:part.notes,conf:part.notes.map(()=>.8),raw:raw.filter(n=>n.instrument===part.instrument),proposed:part.notes.length};
          track.alts!.push(other);if(!touched.has(id))track.ghost=other;touched.add(id);
        }
        if(k===0)showAlt(targetId,0);else commit();
      }else{
        let g:Ghost;
        if(target==="drums")g=await makeDrumGhost(intent,specs[k],fulls[k],logIndex,k,backend,generationBars);
        else{const src=model==="realtime"?fulls[k]:slice(engine.context,fulls[k],0,Math.min(fulls[k].duration,Math.max(24,2*generationBars*barSec+8)));const raw=await transcribe(src,(p)=>setStatus(`3/3 耳コピしています ${Math.round(p*100)}%`));g=makeGhost(target,intent,specs[k],fulls[k],raw,logIndex,k,undefined,model!=="realtime",generationBars);g.model=model}
        g.startStep=startStep;g.bars=generationBars;for(const note of g.notes)note.step+=startStep;
        t.polyphonic=true;t.alts!.push(g);touched.add(targetId);if(k===0)showAlt(targetId,0);else commit();
      }
    }
    if(![...touched].some((id)=>project.tracks[id].alts?.some((g)=>g.notes.length)))throw new Error("音を拾えませんでした。生成音を確認してください");
    project.log[logIndex].proposed=[...touched].reduce((sum,id)=>sum+Math.max(...(project.tracks[id].alts??[]).map((g)=>g.proposed)),0);
    commit();
    setStatus(`${specs.length}案が届きました${backend!=="browser"?`（${touched.size}パート）`:""}`);
  } catch (e) {
    console.error(e);
    setStatus(String((e as Error).message ?? e), true);
  } finally {
    askBtn.disabled = false;
    renderGhostPanel();
  }
};

const LABELS = ["A", "B", "C", "D"];

const previewAudio = $<HTMLAudioElement>("previewAudio");
const previewTake = $<HTMLSelectElement>("previewTake");
const previewBuffers = new Map<number,AudioBuffer>();
let previewUrl:string|null=null;
previewAudio.volume=Number(safeGet("ghostnotes.previewVolume")??.4);
previewAudio.onvolumechange=()=>safeSet("ghostnotes.previewVolume",String(previewAudio.volume));
function renderPreviewChoices(){
  const selected=previewTake.value;
  previewTake.innerHTML=Array.from({length:requestedCount},(_,k)=>`<option value="${k}" ${previewBuffers.has(k)?"":"disabled"}>案${LABELS[k]}${previewBuffers.has(k)?"":"（準備中）"}</option>`).join("");
  previewTake.disabled=!previewBuffers.size;
  previewTake.parentElement!.hidden=requestedCount===1;
  previewTake.value=previewBuffers.has(Number(selected))?selected:String(previewBuffers.keys().next().value??0);
}
function loadPreview(buf:AudioBuffer){
  stopPreview();if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(new Blob([encodeWav(buf)],{type:"audio/wav"}));previewAudio.src=previewUrl;$("previewStop").removeAttribute("disabled");
}
function setPreviewCandidate(k:number,buf:AudioBuffer){
  $("previewPanel").hidden=false;
  const first=previewBuffers.size===0;previewBuffers.set(k,buf);renderPreviewChoices();
  if(askBtn.disabled)setStatus(`2/3 原音 ${previewBuffers.size}/${requestedCount}案の生成が完了しました`);
  if(first){loadPreview(buf);if(monitorChk.checked)void previewAudio.play().catch(()=>{})}
}
previewTake.onchange=()=>{const buf=previewBuffers.get(Number(previewTake.value));if(buf)loadPreview(buf)};
$("previewStop").onclick=stopPreview;
monitorChk.onchange=()=>{if(!monitorChk.checked)stopPreview();else if(previewAudio.src)void previewAudio.play().catch(()=>{})};
function previewWhileWaiting(buf:AudioBuffer){$("previewPanel").hidden=false;loadPreview(buf);void previewAudio.play().catch(()=>{})}
function stopPreview(){previewAudio.pause();if(previewAudio.readyState>0)previewAudio.currentTime=0}

/**
 * ドラムのゴーストを作る（試験的）。Lyria にドラムだけを叩かせ、帯域ごとの音の立ち上がりから
 * キック・スネア・ハイハットの位置を拾う。basic-pitch は音の高さを持つ楽器向けなので使わない。
 */
async function makeDrumGhost(intent: string, spec: LyriaSpec, full: AudioBuffer, logIndex: number, k: number, backend: "browser" | "cpu" | "a100", bars=project.bars): Promise<Ghost> {
  const mono = await toMono22k(full);
  if (backend !== "browser") {
      const hits = await transcribeWithMuscriptor(mono, 22050, ["drums"], backend);
      const { notes, startSec } = drumsToGhost(hits, project.bpm, bars);
      return {
        notes, conf: notes.map(() => 0.8), full, startSec, sourceBpm: project.bpm, raw: [], ampRatio: 0.5,
        spec, intent, explanation: "", logIndex, label: LABELS[k], proposed: notes.length, accepted: 0, model: "muscriptor",
      };

  }
  const startSec = estimateStartSec(mono, 22050, project.bpm);
  const g: Ghost = {
    bars, notes: [], conf: [], full, startSec, sourceBpm: project.bpm, raw: [], mono, ampRatio: 0.5,
    spec, intent, explanation: "", logIndex, label: LABELS[k], proposed: 0, accepted: 0,
  };
  redetectDrums(g, 0.5);
  g.proposed = g.notes.length;
  return g;
}
function redetectDrums(g: Ghost, sensitivity: number) {
  if (!g.mono) return; // muscriptor で拾ったドラムは、感度で拾い直さない
  g.ampRatio = sensitivity;
  const all = transcribeDrums(g.mono!, 22050, { bpm: g.sourceBpm, startSec: g.startSec, bars: g.bars??project.bars, sensitivity })
    .filter((n) => n.vel >= 0.15);
  // 低音域にベースが混ざると、キックをほぼ全ステップで拾ってしまう。キックとスネアは強い順に半分のステップまでに絞る
  // （評価用の音源では、4小節あたり 11〜24 音だった）
  const cap = (g.bars??project.bars) * 8;
  g.notes = [36, 38, 42]
    .flatMap((p) => {
      const hits = all.filter((n) => n.pitch === p).sort((a, b) => b.vel - a.vel);
      return p === 42 ? hits : hits.slice(0, cap);
    })
    .sort((a, b) => a.step - b.step || a.pitch - b.pitch);
  g.notes=g.notes.map(n=>({...n,step:n.step+(g.startStep??0)}));
  g.conf = g.notes.map((n) => Math.min(1, 0.3 + 0.7 * n.vel));
}

/** 耳コピの生の結果からゴーストを作る。startSec と sourceBpm を渡すと、推定をやり直さずにその値を使う */
function makeGhost(
  target: "lead" | "bass", intent: string, spec: LyriaSpec, full: AudioBuffer, raw: Ghost["raw"], logIndex: number, k: number,
  fixed?: { startSec: number; sourceBpm: number; transpose?: number },
  conform = false,
  bars = project.bars,
): Ghost {
  const res = cleanToGhost(raw, { bpm: project.bpm, root: project.root, role: target, bars, conform, ...(fixed ?? {}) });
  const dk = res.detectedKey as { tonic: number; mode: string } | null;
  return {
    bars, notes: res.notes, conf: confidence(res.notes, bars * 16), full, startSec: res.startSec, sourceBpm: res.sourceBpm, raw, ampRatio: 0.35,
    transpose: res.transpose, detectedKey: dk ? `${NOTE_NAMES[dk.tonic]} ${dk.mode === "minor" ? "マイナー" : "メジャー"}` : undefined,
    spec, intent, explanation: "", logIndex, label: LABELS[k], proposed: res.notes.length, accepted: 0,
  };
}

// ---------- デモモード（?demo）と書き出し（?debug） ----------
// 実演で生成が遅れたり失敗したりしたときのために、事前に生成した提案をすぐ出せるようにする。
// 事前生成であることは画面に明示する。
type DemoSet = {
  intent: string; target: "lead" | "bass"; bpm: number; root: string; createdAt: string; bars?:number;
  cands: { spec: LyriaSpec; explanation: string; raw: Ghost["raw"]; startSec: number; sourceBpm: number; transpose?: number; detectedKey?: string; model?: string; audio: string }[];
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
        model: set.cands[0].model === "realtime" || !set.cands[0].model ? "Lyria RealTime" : "Lyria 3.5",
      });
      const logIndex = project.log.length - 1;
      const t = project.tracks[set.target];
      t.alts = set.cands.map((c, k) => {
        const g = makeGhost(set.target, set.intent, c.spec, fulls[k], c.raw, logIndex, k, { startSec: c.startSec, sourceBpm: c.sourceBpm, transpose: c.transpose ?? 0 },false,set.bars??4);
        g.explanation = c.explanation;
        g.model = c.model;
        g.detectedKey = c.detectedKey;
        return g;
      });
      project.log[logIndex].proposed = Math.max(...t.alts.map((g) => g.proposed));
      roll.track = set.target;roll.startBar=0;
      showAlt(set.target, 0);
      setStatus(`事前に生成した2案（${new Date(set.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）`);
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
        transpose: g.transpose ?? 0, detectedKey: g.detectedKey, model: g.model,
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
  roll.track = id;
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
  const sec = (60 / g.sourceBpm) * 4 * (g.bars??project.bars);
  engine.setLyria(slice(engine.context, g.full, g.startSec, sec), project.bpm / g.sourceBpm, g.transpose ?? 0,g.startStep??0);
}

function nudge(d: number) {
  const id = roll.track;
  const g = project.tracks[id].ghost;
  if (!g) return;
  const steps = (g.bars??project.bars) * 16;
  const start=g.startStep??0;
  for (const n of g.notes) n.step = start+(n.step-start + d + steps) % steps;
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
  if (trackRole(project,id) === "drums") {
    // ドラムでは「拾う音の量」を検出の感度として使う（右ほど小さな音まで拾う）
    redetectDrums(g, Math.max(0.05, Math.min(0.95, 1 - ampRatio)));
    commit();
    return;
  }
  if (g.polyphonic) return;
  g.ampRatio = ampRatio;
  const res = cleanToGhost(g.raw, { bpm: project.bpm, root: project.root, role: trackRole(project,id) as "lead" | "bass", bars: g.bars??project.bars, startSec: g.startSec, sourceBpm: g.sourceBpm, transpose: g.transpose ?? 0, ampRatio });
  g.notes = res.notes.map(n=>({...n,step:n.step+(g.startStep??0)}));
  g.conf = confidence(g.notes, (g.bars??project.bars) * 16);
  commit();
}

// ---------- テイクのレーン（案A／案B）と、小節単位の取り込み（コンピング） ----------
// DAW の「テイクを並べて、良い小節だけを選んで1本にまとめる」操作と同じ。小節を押すと、
// トラックのその小節の音を、そのテイクの音で置き換える。もう一度押すと元に戻る（元に戻す操作でも戻せる）。
type CompState = { backup: Record<number, Note[]>; from: Record<number, number> };
const comps: Partial<Record<TrackId, CompState>> = {};

function compBar(k: number, bar: number) {
  const id = roll.track;
  const t = project.tracks[id];
  const alt = t.alts?.[k];
  if (!alt) return;
  const st = (comps[id] ??= { backup: {}, from: {} });
  const inBar = (n: Note) => Math.floor(n.step / 16) === bar;
  const entry = project.log[alt.logIndex];
  if (st.from[bar] === k) {
    const removed = t.notes.filter(inBar).length;
    t.notes = t.notes.filter((n) => !inBar(n)).concat(st.backup[bar] ?? []);
    delete st.from[bar];
    delete st.backup[bar];
    alt.accepted = Math.max(0, alt.accepted - removed);
    if (entry) entry.accepted = Math.max(0, entry.accepted - removed);
  } else {
    if (st.from[bar] !== undefined) {
      const prev = t.alts?.[st.from[bar]];
      const removed = t.notes.filter(inBar).length;
      if (prev) prev.accepted = Math.max(0, prev.accepted - removed);
      if (entry) entry.accepted = Math.max(0, entry.accepted - removed);
    } else {
      st.backup[bar] = t.notes.filter(inBar).map((n) => ({ ...n }));
    }
    const end = (bar + 1) * 16;
    const take = alt.notes.filter(inBar).map((n) => ({ ...n, len: Math.min(n.len, end - n.step) }));
    t.notes = t.notes.filter((n) => !inBar(n)).concat(take);
    st.from[bar] = k;
    alt.accepted += take.length;
    if (entry) entry.accepted += take.length;
  }
  commit();
}

function renderTakes() {
  const box = $("takes");
  const t = project.tracks[roll.track];
  const alts = t.alts ?? (t.ghost ? [t.ghost] : null);
  box.hidden = !alts||alts.every(a=>!a.notes.length);
  if (!alts||alts.every(a=>!a.notes.length)) { box.innerHTML = ""; return; }
  const st = comps[t.id];
  const bars = roll.viewBars;
  box.innerHTML = alts.map((a, k) => `
    <div class="take-lane">
      <button class="take-label" data-take="${k}" aria-pressed="${a === t.ghost}" title="案${a.label}をピアノロールに表示（キー ${k + 1}）"><span class="take-dot"></span>案${a.label}</button>
      <div class="take-bars" style="grid-template-columns: repeat(${bars}, minmax(0, 1fr)); margin-right: 0">
        ${Array.from({ length: bars }, (_, index) => {
          const b=roll.startBar+index;
          const n = a.notes.filter((x) => Math.floor(x.step / 16) === b).length;
          const on = st?.from[b] === k;
          return `<button class="take-bar${n ? "" : " empty"}" data-take="${k}" data-bar="${b}" aria-pressed="${on}" title="${b + 1}小節目を案${a.label}の音で置き換える（${n}音）${on ? "。もう一度押すと元に戻す" : ""}"><canvas></canvas><span class="bar-no">${b + 1}</span>${on ? `<svg class="bar-check"><use href="#i-check" /></svg>` : ""}</button>`;
        }).join("")}
      </div>
    </div>`).join("");
  for (const b of box.querySelectorAll<HTMLButtonElement>(".take-label")) b.onclick = () => showAlt(t.id, Number(b.dataset.take));
  for (const b of box.querySelectorAll<HTMLButtonElement>(".take-bar")) {
    b.onclick = () => compBar(Number(b.dataset.take), Number(b.dataset.bar));
    drawTakeBar(b.querySelector("canvas")!, alts[Number(b.dataset.take)], Number(b.dataset.bar));
  }
}

function drawTakeBar(cv: HTMLCanvasElement, g: Ghost, bar: number) {
  const r = cv.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const c = cv.getContext("2d")!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const notes = g.notes.filter((n) => Math.floor(n.step / 16) === bar);
  if (!notes.length) return;
  const all = g.notes.map((n) => n.pitch);
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = Math.max(6, hi - lo + 1);
  const cw = r.width / 16, rh = (r.height - 6) / span;
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--ghost").trim();
  for (const n of notes) c.fillRect((n.step - bar * 16) * cw + 1, 3 + (hi - n.pitch) * rh, Math.max(2, n.len * cw - 1.5), Math.max(2, rh));
}

function acceptAll() {
  const t=project.tracks[roll.track],g=t.ghost;
  if(!g||!g.notes.length)return;
  t.notes=t.notes.filter(existing=>!g.notes.some(note=>noteConflicts(t.id,existing,note))).concat(g.notes);
  project.log[g.logIndex].accepted+=g.notes.length;g.accepted+=g.notes.length;
  g.notes=[];g.conf=[];
  commit();
}
function closeGhost(keepReason: boolean) {
  const t = project.tracks[roll.track];
  if (!t.ghost) return;
  stopPreview();
  const entry = project.log[t.ghost.logIndex];
  const alts = t.alts ?? [t.ghost];
  entry.chosen = alts.filter((g) => g.accepted > 0).map((g) => g.label).join("+");
  const main = alts.reduce((a, b) => (b.accepted > a.accepted ? b : a));
  entry.spec = main.spec;
  if (keepReason) entry.reason = $<HTMLTextAreaElement>("reason").value.trim();
  $<HTMLTextAreaElement>("reason").value = "";
  t.ghost = null;
  t.alts = null;
  delete comps[t.id];
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
  const compBars = (k: number) => Object.values(comps[t.id]?.from ?? {}).filter((x) => x === k).length;
  $("alts").innerHTML = alts.map((a, k) => {
    const nb = compBars(k);
    return `<div class="take-card" data-alt="${k}" aria-current="${a === g}">
      <div class="take-card-head">
        <button class="take-pick" data-alt="${k}" aria-pressed="${a === g}"><span class="take-dot"></span><b>案${a.label}</b>「${esc(a.spec.title ?? "")}」</button>
        ${nb ? `<span class="badge">${nb}小節採用</span>` : a.accepted ? `<span class="badge">${a.accepted}音採用</span>` : ""}
        <button class="icon-btn listen" data-listen="${k}" title="案${a.label}の原音を聴く" aria-label="案${a.label}の原音を聴く"><svg><use href="#i-speaker" /></svg></button>
      </div>

    </div>`;
  }).join("") + (alts.length < requestedCount && askBtn.disabled ? `<span class="hint">案Bを準備中</span>` : "");
  for (const b of $("alts").querySelectorAll<HTMLButtonElement>(".take-pick")) b.onclick = () => showAlt(t.id, Number(b.dataset.alt));
  for (const b of $("alts").querySelectorAll<HTMLButtonElement>("[data-listen]")) {
    b.onclick = () => {
      const a = alts[Number(b.dataset.listen)];
      previewWhileWaiting(slice(engine.context, a.full, a.startSec, Math.min(a.full.duration - a.startSec, (60 / a.sourceBpm) * 4 * (a.bars??project.bars))));
    };
  }
  renderSpec(g.spec);
  if (g.detectedKey !== undefined) {
    const tp = g.transpose ?? 0;
    $("spec").insertAdjacentHTML("beforeend", `<div class="params">演奏 ${g.sourceBpm.toFixed(1)} BPM・${esc(g.detectedKey ?? "キー不明")}${tp ? `・${tp > 0 ? "+" : ""}${tp} 半音移調` : ""}</div>`);
  }
  sens.closest<HTMLElement>("label")!.hidden = !!g.polyphonic;
  sens.value = String(Math.round((t.id === "drums" ? g.ampRatio : 1 - g.ampRatio) * 100));
  const occupied=new Set(g.notes.map(n=>Math.floor(n.step/16))).size;
  $("ghostSummary").textContent = g.notes.length?`残り ${g.notes.length}音 · 採用 ${g.accepted}音 · ${occupied}/${g.bars??project.bars}小節`:`${g.accepted}音採用済み`;
  for(const id of ["nudgeL","nudgeR","acceptAll"])$<HTMLButtonElement>(id).disabled=!g.notes.length;
  if(g.polyphonic)$("spec").insertAdjacentHTML("beforeend",`<div class="params">原音の開始 ${g.startSec.toFixed(2)}秒・推定 ${g.sourceBpm.toFixed(1)} BPM</div>`);
  $("explain").textContent = g.explanation;
  $("explainDetails").hidden = !g.explanation;
}

function renderLog() {
  const box = $("log");
  if (!project.log.length) { box.innerHTML = `<li class="hint">履歴なし</li>`; return; }
  box.innerHTML = [...project.log].reverse().map((e) => {
    const time = new Date(e.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    const what = e.chosen ? `採用 案${esc(e.chosen)}` : e.accepted ? `採用 ${e.accepted}音` : "見送り";
    return `<li><div class="log-line"><span class="log-time">${time}</span><b class="${e.chosen || e.accepted ? "log-yes" : "log-no"}">${what}</b><span>${project.tracks[e.track]?.name ?? e.track}・${e.accepted}/${e.proposed}音</span></div>
      ${e.reason ? `<div class="reason">${esc(e.reason)}</div>` : ""}<div class="intent">${esc(e.intent)}${e.model ? `（${esc(e.model)}）` : ""}${e.titles ? `<br>${e.titles.map(esc).join(" ／ ")}` : ""}</div></li>`;
  }).join("");
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
  else if (e.key === "Home") { e.preventDefault(); $("toStart").click(); }
});

function setStatus(s: string, error = false) {
  statusEl.textContent = s;
  statusEl.classList.toggle("error", error);
  // 「2/3 …」のような段階の表示から、進み具合のバーを動かす
  const m = /^(\d)\/(\d)/.exec(s);
  const bar = $("progressBar");
  if (m) bar.style.width = `${(Number(m[1]) / Number(m[2])) * 100}%`;
  else if (/案が届きました|表示しています/.test(s)) bar.style.width = "100%";
  else if (!askBtn.disabled) bar.style.width = "0";
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
  roll.startBar=Math.max(0,roll.startBar);
  viewStart.value=String(roll.startBar+1);
  timeline.max=String(Math.max(64,project.bars+32,roll.startBar+roll.viewBars*8));timeline.value=String(roll.startBar);
  vel.startBar=roll.startBar;vel.viewBars=roll.viewBars;
  renderTracks();
  renderTakes();
  renderGhostPanel();
  renderLog();
  renderModes();
  const t = project.tracks[roll.track];
  $("rollTitle").textContent = t.name;
  $("rollMeta").textContent = `${t.notes.length}音${t.ghost ? `・提案 ${t.ghost.notes.length}音（案${t.ghost.label}）` : ""}`;
  document.querySelector<HTMLElement>(".lg-note")!.style.background = `var(--track-${trackRole(project,t.id)})`;
  roll.draw();
  vel.draw();
}
function commit() {
  const extent=contentBars(project);
  if(project.bars!==extent){project.bars=extent;engine.setBars(extent)}
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
    tracks: Object.fromEntries(Object.values(project.tracks).map((t) => [t.id, { id:t.id, name:t.name, role:t.role, instrument:t.instrument, notes: t.notes, mute: t.mute, solo: t.solo, volume: t.volume, preset: t.preset, polyphonic:t.polyphonic }])),
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
  for(const id of Object.keys(project.tracks) as TrackId[]) if(!o.tracks[id]) delete project.tracks[id];
  for (const [id, t] of Object.entries(o.tracks) as [TrackId, typeof project.tracks.lead][]) project.tracks[id]={...(project.tracks[id]??{ghost:null}),...t};
  if(!project.tracks[roll.track])roll.track=Object.keys(project.tracks)[0] as TrackId;
  project.bars=contentBars(project);
  bpmInput.value = String(project.bpm);
  keySel.value = project.root;
  engine.setBpm(project.bpm);
  engine.setBars(project.bars);
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
  setStatus("WAV に書き出しています");
  try {
    const buf = await renderMix(project, 2);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    downloadBytes(encodeWav(buf), `ghostnotes-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.wav`, "audio/wav");
    setStatus(`WAV に書き出しました（${buf.duration.toFixed(1)} 秒）`);
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
