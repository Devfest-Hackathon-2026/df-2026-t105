import { DRUM_ROWS, noteKey, trackRole, trackRange, type Note, type Project, type TrackId } from "./state";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = [1, 3, 6, 8, 10];
/** これだけ動いたらドラッグ（移動・リサイズ）、動かなければクリック（削除／選択）とみなす距離（px） */
const CLICK_RADIUS = 4;
/** 左の鍵盤の幅と、上の小節の目盛りの高さ。テイクのレーンとベロシティ欄もこの幅を空けて列をそろえる */
export const KEY_W = 112;
export const RULER_H = 22;

const roundStep = (s: number) => Math.round(s * 960) / 960;

export type RollTool = "draw" | "select";

type DragItem = {
  ref: Note;
  orig: Note;
  origRow: number;
  next: Note;
};

/** ピアノロール。本物のノートは塗り、ゴーストは確信度に応じた濃さの枠で描く */
export class Roll {
  private ctx: CanvasRenderingContext2D;
  track: TrackId = "lead";
  playStep = -1;
  startBar = 0;
  viewBars = 4;
  snap = 1;
  tool: RollTool = "draw";
  /** 選択中のノート集合（矩形選択・Shiftクリック・一括移動・コピペ・トランスポーズ用） */
  selected = new Set<Note>();
  /** クリップボード（相対 step で保持） */
  private clipboard: Note[] = [];
  /** 直近にクリックしたステップ位置（ペースト基準位置） */
  lastClickStep = 0;
  /** ペンで新しく置くノートの既定の長さ（null なら現在のグリッド幅） */
  defaultLen: number | null = null;

  private hover: { step: number; pitch: number } | null = null;
  private labelW = KEY_W;
  /** 鍵盤をクリック・ドラッグしたときに音を鳴らす */
  onAudition: (pitch: number) => void = () => {};
  /** ルーラーをクリック・ドラッグしたときに再生位置を移動する */
  onSeek: (step: number) => void = () => {};
  /** ツールや選択状態が変わったときに UI を更新する */
  onStateChange: () => void = () => {};
  /** 複数ノートの一括編集（範囲移動・複製・削除・ペースト・クオンタイズ等） */
  onBatchEdit: (track: TrackId, notes: Note[]) => void = () => {};

  /** ドラッグ中の状態 */
  private drag: {
    pointerId: number;
    mode: "move" | "resize" | "resize-left" | "create" | "box" | "ruler" | "keys";
    note: Note;
    items: DragItem[];
    duplicate: boolean;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    origStep: number;
    origLen: number;
    origRow: number;
    origViewBars: number;
    lastAuditionPitch: number;
    next: Note;
    moved: boolean;
  } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private get: () => Project,
    /** move / resize のときは next に変更後のノートを渡す */
    private onEdit: (kind: "add" | "remove" | "accept" | "reject" | "move" | "resize", track: TrackId, note: Note, next?: Note) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerleave", () => {
      if (this.drag) return; // ドラッグ中はキャプチャしているので追い出さない
      this.hover = null;
      this.draw();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    canvas.addEventListener("pointercancel", () => this.cancelDrag());
    // ドラッグ中に Esc が押されたら取り消す
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.drag) this.cancelDrag();
    });
  }

  private rows(): { pitch: number; label: string; black: boolean }[] {
    if (trackRole(this.get(), this.track) === "drums") {
      const t = this.get().tracks[this.track];
      const pitches = [...new Set([...DRUM_ROWS.map((r) => r.pitch), ...t.notes.map((n) => n.pitch), ...(t.ghost?.notes.map((n) => n.pitch) ?? [])])].sort((a, b) => a - b);
      return pitches.map((pitch) => ({ pitch, label: DRUM_ROWS.find((r) => r.pitch === pitch)?.name ?? `Drum ${pitch}`, black: false }));
    }
    const [lo, hi] = trackRange(this.get(), this.track);
    const out = [];
    for (let p = hi; p >= lo; p--) out.push({ pitch: p, label: p % 12 === 0 || p === hi ? `${NAMES[p % 12]}${Math.floor(p / 12) - 1}` : "", black: BLACK.includes(p % 12) });
    return out;
  }

  private geom() {
    const r = this.canvas.getBoundingClientRect();
    const rows = this.rows();
    const steps = this.viewBars * 16;
    const cw = (r.width - this.labelW) / steps;
    const rh = (r.height - RULER_H) / rows.length;
    return { r, rows, steps, cw, rh };
  }

  private keyPitchAt(relX: number, relY: number): number | null {
    const { rows, rh } = this.geom();
    const idx = Math.floor((relY - RULER_H) / rh);
    const row = rows[idx];
    if (!row) return null;
    if (trackRole(this.get(), this.track) !== "drums" && row.black && relX >= this.labelW * 0.62) {
      const inRowY = relY - RULER_H - idx * rh;
      const neighbor = rows[inRowY < rh / 2 ? idx - 1 : idx + 1];
      if (neighbor) return neighbor.pitch;
    }
    return row.pitch;
  }

  private hit(e: PointerEvent | MouseEvent) {
    const { r, rows, steps, cw, rh } = this.geom();
    const x = e.clientX - r.left - this.labelW, y = e.clientY - r.top - RULER_H;
    if (x < 0) return null;
    const grid = this.snap || 1 / 960;
    const step = roundStep(Math.floor(x / cw / grid) * grid), row = Math.floor(y / rh);
    if (step < 0 || step >= steps || row < 0 || row >= rows.length) return null;
    return { step: roundStep(step + this.startBar * 16), pitch: rows[row].pitch };
  }

  /** ポインターの下にあるものを調べる。自分のノートのときは左端・右端（長さ変更のつかみ位置）かどうかも返す */
  private probe(e: PointerEvent | MouseEvent):
    | { kind: "outside" }
    | { kind: "empty" }
    | { kind: "ghost"; note: Note }
    | { kind: "note"; note: Note; edge: "left" | "right" | null } {
    const { r, rows, steps, cw, rh } = this.geom();
    const x = e.clientX - r.left - this.labelW, y = e.clientY - r.top - RULER_H;
    if (x < 0 || y < 0) return { kind: "outside" };
    const step = x / cw, row = Math.floor(y / rh);
    if (step < 0 || step >= steps || row < 0 || row >= rows.length) return { kind: "outside" };
    const pitch = rows[row].pitch;
    const t = this.get().tracks[this.track];
    const isDrums = trackRole(this.get(), this.track) === "drums";
    const covers = (n: Note) =>
      n.pitch === pitch &&
      step + this.startBar * 16 >= n.step &&
      step + this.startBar * 16 < n.step + Math.max(n.len, (isDrums ? 8 : 3) / cw);
    const nearest = (notes: Note[]) =>
      notes.filter(covers).sort((a, b) => Math.abs(a.step - (step + this.startBar * 16)) - Math.abs(b.step - (step + this.startBar * 16)))[0];
    const ghost = nearest(t.ghost?.notes ?? []);
    if (ghost) return { kind: "ghost", note: ghost };
    const real = nearest(t.notes);
    if (!real) return { kind: "empty" };
    if (isDrums) return { kind: "note", note: real, edge: null };
    const leftPx = (real.step - this.startBar * 16) * cw;
    const w = real.len * cw;
    const grip = w < 24 ? w * 0.25 : 6;
    const rightEdge = x >= leftPx + w - grip;
    const leftEdge = !rightEdge && w >= 16 && x <= leftPx + grip;
    return { kind: "note", note: real, edge: rightEdge ? "right" : leftEdge ? "left" : null };
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.tool !== "select") return;
    const p = this.probe(e);
    if (p.kind === "note") {
      this.selected.delete(p.note);
      this.onEdit("remove", this.track, p.note);
      this.onStateChange();
    } else if (p.kind === "empty") {
      const h = this.hit(e);
      if (h) {
        const len = roundStep(this.defaultLen ?? (this.snap || 1));
        this.onAudition(h.pitch);
        this.onEdit("add", this.track, { step: h.step, len, pitch: h.pitch, vel: 0.8 });
      }
    }
  }

  private onPointerDown(e: PointerEvent) {
    if (this.drag) return; // すでにドラッグ中（2本目の指など）は無視
    const { r, rows, cw, rh } = this.geom();
    const relX = e.clientX - r.left;
    const relY = e.clientY - r.top;

    // 1. 上の小節ルーラーをクリック／ドラッグ → 再生位置シーク＆上下ドラッグでズーム
    if (relX >= this.labelW && relY >= 0 && relY < RULER_H) {
      const grid = this.snap || 0.25;
      const rawStep = (relX - this.labelW) / cw + this.startBar * 16;
      const step = Math.max(0, roundStep(Math.floor(rawStep / grid) * grid));
      this.lastClickStep = step;
      this.onSeek(step);
      const dummy: Note = { step, len: 1, pitch: 60, vel: 0.8 };
      this.drag = {
        pointerId: e.pointerId,
        mode: "ruler",
        note: dummy,
        items: [],
        duplicate: false,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        origStep: step,
        origLen: 1,
        origRow: 0,
        origViewBars: this.viewBars,
        lastAuditionPitch: -1,
        next: dummy,
        moved: false,
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.draw();
      return;
    }

    // 2. 左の鍵盤を押したら、その高さの音を鳴らす（上下ドラッグで連続試聴）
    if (relX < this.labelW && relY >= RULER_H) {
      const pitch = this.keyPitchAt(relX, relY);
      if (pitch !== null) {
        this.onAudition(pitch);
        const dummy: Note = { step: 0, len: 1, pitch, vel: 0.8 };
        this.drag = {
          pointerId: e.pointerId,
          mode: "keys",
          note: dummy,
          items: [],
          duplicate: false,
          startX: e.clientX,
          startY: e.clientY,
          curX: e.clientX,
          curY: e.clientY,
          origStep: 0,
          origLen: 1,
          origRow: 0,
          origViewBars: this.viewBars,
          lastAuditionPitch: pitch,
          next: dummy,
          moved: false,
        };
        this.canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    const p = this.probe(e);
    if (p.kind === "ghost") {
      // ゴーストは従来どおり、その場で採用・消去
      this.onEdit(e.button === 2 ? "reject" : "accept", this.track, p.note);
      return;
    }

    const h = this.hit(e);
    if (h) this.lastClickStep = h.step;

    // 3. 空白部分のクリック／ドラッグ
    if (p.kind !== "note") {
      if (p.kind === "outside" || !h) return;
      // 選択ツール、または Shift+ドラッグ／右ドラッグなら矩形範囲選択（Marquee Box Selection）
      if (this.tool === "select" || e.shiftKey || e.button === 2) {
        if (!e.shiftKey) this.selected.clear();
        const dummy: Note = { step: h.step, len: 1, pitch: h.pitch, vel: 0.8 };
        this.drag = {
          pointerId: e.pointerId,
          mode: "box",
          note: dummy,
          items: [],
          duplicate: false,
          startX: e.clientX,
          startY: e.clientY,
          curX: e.clientX,
          curY: e.clientY,
          origStep: h.step,
          origLen: 1,
          origRow: 0,
          origViewBars: this.viewBars,
          lastAuditionPitch: -1,
          next: dummy,
          moved: false,
        };
        this.canvas.setPointerCapture(e.pointerId);
        this.onStateChange();
        this.draw();
        return;
      }
      if (e.button !== 0) return;
      // ペンツール: クリックでノート作成開始、右へドラッグすれば長さを伸縮
      this.selected.clear();
      const initLen = roundStep(this.defaultLen ?? (this.snap || 0.25));
      const newNote: Note = { step: h.step, len: initLen, pitch: h.pitch, vel: 0.8 };
      this.onAudition(h.pitch);
      this.drag = {
        pointerId: e.pointerId,
        mode: "create",
        note: newNote,
        items: [],
        duplicate: false,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        origStep: newNote.step,
        origLen: newNote.len,
        origRow: rows.findIndex((row) => row.pitch === newNote.pitch),
        origViewBars: this.viewBars,
        lastAuditionPitch: h.pitch,
        next: { ...newNote },
        moved: false,
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.hover = null;
      this.draw();
      return;
    }

    // 4. 自分のノートの上
    e.preventDefault();
    if (e.button === 2) {
      // 右クリックは即座に削除
      this.selected.delete(p.note);
      this.onEdit("remove", this.track, p.note);
      this.onStateChange();
      return;
    }
    if (e.shiftKey) {
      // Shift+クリックで複数選択のトグル
      if (this.selected.has(p.note)) this.selected.delete(p.note);
      else this.selected.add(p.note);
      this.onStateChange();
      this.draw();
      return;
    }
    if (!this.selected.has(p.note)) {
      this.selected.clear();
      this.selected.add(p.note);
      this.onStateChange();
    }

    const activeNotes = [...this.selected];
    const items: DragItem[] = activeNotes.map((n) => ({
      ref: n,
      orig: { ...n },
      origRow: rows.findIndex((row) => row.pitch === n.pitch),
      next: { ...n },
    }));
    const dragMode = p.edge === "left" ? "resize-left" : p.edge === "right" ? "resize" : "move";
    this.drag = {
      pointerId: e.pointerId,
      mode: dragMode,
      note: p.note,
      items,
      duplicate: e.altKey || e.ctrlKey || e.metaKey,
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      origStep: p.note.step,
      origLen: p.note.len,
      origRow: rows.findIndex((row) => row.pitch === p.note.pitch),
      origViewBars: this.viewBars,
      lastAuditionPitch: p.note.pitch,
      next: { ...p.note },
      moved: false,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = p.edge ? "ew-resize" : "grab";
    this.hover = null;
    this.draw();
  }

  private onPointerMove(e: PointerEvent) {
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      this.drag.curX = e.clientX;
      this.drag.curY = e.clientY;
      const dx = e.clientX - this.drag.startX, dy = e.clientY - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) >= CLICK_RADIUS) this.drag.moved = true;
      if (this.drag.mode === "keys") {
        const { r } = this.geom();
        const pitch = this.keyPitchAt(Math.max(0, Math.min(this.labelW - 1, e.clientX - r.left)), e.clientY - r.top);
        if (pitch !== null && pitch !== this.drag.lastAuditionPitch) {
          this.drag.lastAuditionPitch = pitch;
          this.onAudition(pitch);
        }
        return;
      }
      if (this.drag.mode === "ruler") {
        const { r, cw } = this.geom();
        const zoomLevels = [1, 2, 4, 8, 16];
        if (Math.abs(dy) >= 24) {
          const baseIdx = Math.max(0, zoomLevels.indexOf(this.drag.origViewBars));
          const deltaIdx = Math.round(-dy / 32);
          const nextBars = zoomLevels[Math.max(0, Math.min(zoomLevels.length - 1, baseIdx + deltaIdx))];
          if (nextBars && nextBars !== this.viewBars) {
            this.viewBars = nextBars;
            this.onStateChange();
          }
        } else {
          const grid = this.snap || 0.25;
          const rawStep = Math.max(0, (e.clientX - r.left - this.labelW) / cw + this.startBar * 16);
          const step = roundStep(Math.floor(rawStep / grid) * grid);
          this.lastClickStep = step;
          this.onSeek(step);
        }
        this.draw();
        return;
      }
      if (this.drag.moved) this.updateNext(dx, dy);
      this.canvas.style.cursor =
        this.drag.mode === "resize" || this.drag.mode === "resize-left" || this.drag.mode === "create"
          ? "ew-resize"
          : this.drag.mode === "box"
            ? "crosshair"
            : this.drag.moved
              ? "grabbing"
              : "grab";
      this.draw();
      return;
    }
    this.hover = this.hit(e);
    this.updateCursor(e);
    this.draw();
  }

  /** ポインターの移動量からドラッグ先のノートを作る */
  private updateNext(dx: number, dy: number) {
    if (!this.drag) return;
    const { r, rows, cw, rh } = this.geom();
    const d = this.drag;
    const minUnit = roundStep(this.snap || 1 / 960);

    if (d.mode === "box") {
      const x0 = Math.min(d.startX, d.curX) - r.left - this.labelW;
      const x1 = Math.max(d.startX, d.curX) - r.left - this.labelW;
      const y0 = Math.min(d.startY, d.curY) - r.top - RULER_H;
      const y1 = Math.max(d.startY, d.curY) - r.top - RULER_H;
      const step0 = x0 / cw + this.startBar * 16;
      const step1 = x1 / cw + this.startBar * 16;
      const t = this.get().tracks[this.track];
      this.selected.clear();
      for (const n of t.notes) {
        const rowIdx = rows.findIndex((row) => row.pitch === n.pitch);
        if (rowIdx < 0) continue;
        const ny0 = rowIdx * rh, ny1 = (rowIdx + 1) * rh;
        if (n.step + n.len >= step0 && n.step <= step1 && ny1 >= y0 && ny0 <= y1) {
          this.selected.add(n);
        }
      }
      this.onStateChange();
      return;
    }

    if (d.mode === "create") {
      const rawEnd = d.origStep + Math.max(minUnit, dx / cw + (this.snap || 0.25));
      const snappedEnd = this.snap ? Math.round(rawEnd / this.snap) * this.snap : rawEnd;
      const len = Math.max(minUnit, roundStep(snappedEnd - d.origStep));
      d.next = { ...d.note, len };
      this.defaultLen = len;
      return;
    }

    if (d.mode === "move") {
      const rawDeltaStep = dx / cw;
      const snappedTargetStep = Math.max(
        0,
        roundStep(this.snap ? Math.round((d.origStep + rawDeltaStep) / this.snap) * this.snap : d.origStep + rawDeltaStep),
      );
      const stepDelta = roundStep(snappedTargetStep - d.origStep);
      const rowDelta = Math.round(dy / rh);
      for (const item of d.items) {
        const nextStep = Math.max(0, roundStep(item.orig.step + stepDelta));
        const nextRow = Math.max(0, Math.min(rows.length - 1, item.origRow + rowDelta));
        item.next = { ...item.orig, step: nextStep, pitch: rows[nextRow]?.pitch ?? item.orig.pitch };
        if (item.ref === d.note) d.next = item.next;
      }
      if (d.next.pitch !== d.lastAuditionPitch) {
        d.lastAuditionPitch = d.next.pitch;
        this.onAudition(d.next.pitch);
      }
    } else if (d.mode === "resize") {
      const rawDeltaLen = dx / cw;
      const targetLen = Math.max(
        minUnit,
        roundStep(this.snap ? Math.round((d.origLen + rawDeltaLen) / this.snap) * this.snap : d.origLen + rawDeltaLen),
      );
      const lenDelta = roundStep(targetLen - d.origLen);
      for (const item of d.items) {
        const len = Math.max(minUnit, roundStep(item.orig.len + lenDelta));
        item.next = { ...item.orig, len };
        if (item.ref === d.note) d.next = item.next;
      }
      this.defaultLen = d.next.len;
    } else if (d.mode === "resize-left") {
      const origEnd = roundStep(d.origStep + d.origLen);
      const rawStart = d.origStep + dx / cw;
      const snappedStart = Math.max(
        0,
        Math.min(origEnd - minUnit, roundStep(this.snap ? Math.round(rawStart / this.snap) * this.snap : rawStart)),
      );
      const startDelta = roundStep(snappedStart - d.origStep);
      for (const item of d.items) {
        const end = roundStep(item.orig.step + item.orig.len);
        const step = Math.max(0, Math.min(end - minUnit, roundStep(item.orig.step + startDelta)));
        const len = Math.max(minUnit, roundStep(end - step));
        item.next = { ...item.orig, step, len };
        if (item.ref === d.note) d.next = item.next;
      }
      this.defaultLen = d.next.len;
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch {}

    if (d.mode === "ruler" || d.mode === "keys" || d.mode === "box") {
      this.updateCursor(e);
      this.draw();
      return;
    }

    if (d.mode === "create") {
      this.selected.clear();
      this.selected.add(d.next);
      this.onEdit("add", this.track, d.next);
      this.onStateChange();
      this.updateCursor(e);
      this.draw();
      return;
    }

    if (d.moved) {
      if (d.items.length === 1 && !d.duplicate && d.mode !== "resize-left") {
        const changed = d.next.step !== d.note.step || d.next.len !== d.note.len || d.next.pitch !== d.note.pitch;
        if (changed) {
          this.selected.clear();
          this.selected.add(d.next);
          this.onEdit(d.mode === "move" ? "move" : "resize", this.track, d.note, d.next);
        }
      } else {
        const t = this.get().tracks[this.track];
        const movingRefs = new Set(d.items.map((it) => it.ref));
        const baseNotes = d.duplicate ? [...t.notes] : t.notes.filter((n) => !movingRefs.has(n));
        const placed = d.items.map((it) => ({
          ...it.next,
          step: Math.max(0, it.next.step),
          len: Math.max(1 / 960, it.next.len),
        }));
        const filtered = baseNotes.filter(
          (existing) => !placed.some((p) => existing.pitch === p.pitch && Math.abs(existing.step - p.step) < 1e-4),
        );
        const nextTrackNotes = [...filtered, ...placed].sort((a, b) => a.step - b.step || a.pitch - b.pitch);
        this.selected = new Set(placed);
        this.onBatchEdit(this.track, nextTrackNotes);
      }
    } else {
      // 動かずに離したとき: ペンツールならクリック削除、選択ツールならそのノートだけを選択
      if (this.tool === "draw") {
        this.selected.delete(d.note);
        this.onEdit("remove", this.track, d.note);
      } else {
        this.selected.clear();
        this.selected.add(d.note);
      }
      this.onStateChange();
    }
    this.updateCursor(e);
    this.draw();
  }

  /** Esc や pointercancel でドラッグを取り消す（何も変更しない） */
  private cancelDrag() {
    if (!this.drag) return;
    const id = this.drag.pointerId;
    this.drag = null;
    try { this.canvas.releasePointerCapture(id); } catch {}
    this.canvas.style.cursor = "";
    this.draw();
  }

  // ---------- Yuna DAW 準拠のノート編集コマンド ----------

  selectAll() {
    const t = this.get().tracks[this.track];
    this.selected = new Set(t.notes);
    this.onStateChange();
    this.draw();
  }

  clearSelection(): boolean {
    if (!this.selected.size) return false;
    this.selected.clear();
    this.onStateChange();
    this.draw();
    return true;
  }

  deleteSelected(): boolean {
    const t = this.get().tracks[this.track];
    const active = t.notes.filter((n) => this.selected.has(n));
    if (!active.length) return false;
    const remaining = t.notes.filter((n) => !this.selected.has(n));
    this.selected.clear();
    this.onBatchEdit(this.track, remaining);
    this.onStateChange();
    return true;
  }

  copySelected(): boolean {
    const t = this.get().tracks[this.track];
    const active = t.notes.filter((n) => this.selected.has(n));
    if (!active.length) return false;
    const minStep = Math.min(...active.map((n) => n.step));
    this.clipboard = active.map((n) => ({ ...n, step: roundStep(n.step - minStep) }));
    return true;
  }

  cutSelected(): boolean {
    if (!this.copySelected()) return false;
    return this.deleteSelected();
  }

  paste(atStep?: number): boolean {
    if (!this.clipboard.length) return false;
    const t = this.get().tracks[this.track];
    const baseStep = Math.max(0, roundStep(atStep ?? (this.playStep >= 0 ? this.playStep : this.lastClickStep)));
    const pasted = this.clipboard.map((n) => ({ ...n, step: roundStep(baseStep + n.step) }));
    const filtered = t.notes.filter(
      (existing) => !pasted.some((p) => existing.pitch === p.pitch && Math.abs(existing.step - p.step) < 1e-4),
    );
    this.selected = new Set(pasted);
    this.onBatchEdit(this.track, [...filtered, ...pasted].sort((a, b) => a.step - b.step || a.pitch - b.pitch));
    this.onStateChange();
    return true;
  }

  duplicateSelected(): boolean {
    const t = this.get().tracks[this.track];
    const active = t.notes.filter((n) => this.selected.has(n));
    if (!active.length) return false;
    const minStart = Math.min(...active.map((n) => n.step));
    const maxEnd = Math.max(...active.map((n) => n.step + n.len));
    const span = Math.max(this.snap || 1, roundStep(maxEnd - minStart));
    const duped = active.map((n) => ({ ...n, step: roundStep(n.step + span) }));
    const filtered = t.notes.filter(
      (existing) => !duped.some((p) => existing.pitch === p.pitch && Math.abs(existing.step - p.step) < 1e-4),
    );
    this.selected = new Set(duped);
    this.onBatchEdit(this.track, [...filtered, ...duped].sort((a, b) => a.step - b.step || a.pitch - b.pitch));
    this.onStateChange();
    return true;
  }

  transposeSelected(semitones: number): boolean {
    if (trackRole(this.get(), this.track) === "drums") return false;
    const t = this.get().tracks[this.track];
    const active = t.notes.filter((n) => this.selected.has(n));
    if (!active.length) return false;
    const nextSelected = new Set<Note>();
    const updated = t.notes.map((n) => {
      if (!this.selected.has(n)) return n;
      const moved = { ...n, pitch: Math.max(0, Math.min(127, n.pitch + semitones)) };
      nextSelected.add(moved);
      return moved;
    });
    this.selected = nextSelected;
    if (nextSelected.size === 1) this.onAudition([...nextSelected][0].pitch);
    this.onBatchEdit(this.track, updated);
    return true;
  }

  nudgeSelected(deltaSteps: number): boolean {
    const t = this.get().tracks[this.track];
    const active = t.notes.filter((n) => this.selected.has(n));
    if (!active.length) return false;
    const nextSelected = new Set<Note>();
    const updated = t.notes.map((n) => {
      if (!this.selected.has(n)) return n;
      const moved = { ...n, step: Math.max(0, roundStep(n.step + deltaSteps)) };
      nextSelected.add(moved);
      return moved;
    });
    this.selected = nextSelected;
    this.onBatchEdit(this.track, updated.sort((a, b) => a.step - b.step || a.pitch - b.pitch));
    return true;
  }

  quantizeSelected(): boolean {
    const grid = this.snap || 1;
    const t = this.get().tracks[this.track];
    if (!t.notes.length) return false;
    const hasSel = t.notes.some((n) => this.selected.has(n));
    const nextSelected = new Set<Note>();
    const updated = t.notes.map((n) => {
      if (hasSel && !this.selected.has(n)) return n;
      const step = Math.max(0, roundStep(Math.round(n.step / grid) * grid));
      const q = { ...n, step };
      if (hasSel) nextSelected.add(q);
      return q;
    });
    if (hasSel) this.selected = nextSelected;
    this.onBatchEdit(this.track, updated.sort((a, b) => a.step - b.step || a.pitch - b.pitch));
    return true;
  }

  /** ポインターの下にあるものに合わせてカーソルを変える */
  private updateCursor(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const relX = e.clientX - r.left;
    const relY = e.clientY - r.top;
    if (relX >= this.labelW && relY >= 0 && relY < RULER_H) {
      this.canvas.style.cursor = "pointer";
      return;
    }
    const onKeys = relX < this.labelW && relY > RULER_H;
    if (onKeys) {
      this.canvas.style.cursor = "pointer";
      return;
    }
    const p = this.probe(e);
    this.canvas.style.cursor =
      p.kind === "outside"
        ? "default"
        : p.kind === "ghost"
          ? "pointer"
          : p.kind === "empty"
            ? this.tool === "select"
              ? "default"
              : "crosshair"
            : p.edge
              ? "ew-resize"
              : "grab";
  }

  draw() {
    const rowCount = this.rows().length;
    const parentHeight = this.canvas.parentElement?.clientHeight ?? 260;
    const height = Math.max(parentHeight, RULER_H + rowCount * (trackRole(this.get(), this.track) === "drums" ? 20 : 16));
    if (this.canvas.style.height !== `${height}px`) this.canvas.style.height = `${height}px`;
    const dpr = devicePixelRatio || 1;
    const { r, rows, steps, cw, rh } = this.geom();
    if (this.canvas.width !== Math.round(r.width * dpr) || this.canvas.height !== Math.round(r.height * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    const c = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const L = this.labelW, T = RULER_H;
    const font = getComputedStyle(document.body).fontFamily;
    const drums = trackRole(this.get(), this.track) === "drums";
    const bars = steps / 16;

    // 行の背景（黒鍵の行は少し沈める）
    rows.forEach((row, i) => {
      c.fillStyle = row.black ? v("--roll-black") : v("--roll-white");
      c.fillRect(L, T + i * rh, r.width - L, rh);
    });
    // 縦の格子: 小節、拍、16分（またはシャッフル三連）
    let drawGrid = this.snap || 1;
    while (drawGrid * cw < 5 && drawGrid < 4) drawGrid *= 2;
    const nLines = Math.round(steps / drawGrid);
    for (let i = 0; i <= nLines; i++) {
      const s = roundStep(i * drawGrid);
      const bar = Math.abs(s / 16 - Math.round(s / 16)) < 0.0001;
      const beat = Math.abs(s / 4 - Math.round(s / 4)) < 0.0001;
      c.fillStyle = bar ? v("--grid-bar") : beat ? v("--grid-beat") : v("--grid");
      c.fillRect(Math.round(L + s * cw) - (bar ? 1 : 0), T, bar ? 1.5 : 1, r.height - T);
    }
    // オクターブの境目（C の上）に横線
    if (!drums) {
      c.fillStyle = v("--grid-beat");
      rows.forEach((row, i) => { if (row.pitch % 12 === 11) c.fillRect(L, T + i * rh, r.width - L, 1); });
    }
    // 再生位置
    if (this.playStep >= this.startBar * 16 && this.playStep < (this.startBar + this.viewBars) * 16) {
      c.fillStyle = v("--playhead-soft");
      c.fillRect(L + (this.playStep - this.startBar * 16) * cw, T, cw, r.height - T);
      c.fillStyle = v("--playhead");
      c.fillRect(L + (this.playStep - this.startBar * 16) * cw, T, 1.5, r.height - T);
    }

    const y = (p: number) => T + rows.findIndex((row) => row.pitch === p) * rh;
    const t = this.get().tracks[this.track];
    const noteColor = v(`--track-${trackRole(this.get(), this.track)}`);
    const dragRefs = new Set(this.drag?.items.map((it) => it.ref) ?? []);

    /** ノートを1個描く。mul で薄くできる（ドラッグ元のプレビュー用） */
    const drawNote = (n: Note, mul = 1, isSelected = false) => {
      const yy = y(n.pitch);
      if (yy < T || n.step + n.len < this.startBar * 16 || n.step >= (this.startBar + this.viewBars) * 16) return;
      const nx = L + (n.step - this.startBar * 16) * cw + 1;
      const nw = Math.max(drums ? 8 : 3, n.len * cw - 2);
      c.fillStyle = noteColor;
      c.globalAlpha = (0.6 + 0.4 * n.vel) * mul;
      c.beginPath();
      c.roundRect(nx, yy + 1, nw, rh - 2, 3);
      c.fill();
      if (isSelected) {
        c.globalAlpha = 1;
        c.strokeStyle = v("--text");
        c.lineWidth = 1.6;
        c.stroke();
      }
      c.globalAlpha = 1;
    };

    for (const n of t.notes) {
      if (this.drag && dragRefs.has(n)) continue;
      drawNote(n, 1, this.selected.has(n));
    }
    if (this.drag) {
      if (this.drag.mode === "create") {
        drawNote(this.drag.next, 0.9, true);
      } else if (this.drag.items.length > 0) {
        for (const it of this.drag.items) {
          drawNote(it.orig, this.drag.duplicate ? 0.85 : 0.25, false);
          drawNote(it.next, 1, true);
        }
      }
    }

    // AI に直してもらった版: 消した音を灰色の点線と取り消し線で示す（直す前と比べられるように）
    const rv = t.ghost?.revision;
    const changed = rv ? new Set(rv.changed) : null;
    rv?.removed.forEach((n) => {
      const yy = y(n.pitch);
      if (yy < T || n.step + n.len < this.startBar * 16 || n.step >= (this.startBar + this.viewBars) * 16) return;
      const nx = L + (n.step - this.startBar * 16) * cw + 1.5, nw = Math.max(drums ? 8 : 3, n.len * cw - 3);
      c.strokeStyle = v("--muted");
      c.globalAlpha = 0.7;
      c.lineWidth = 1.2;
      c.setLineDash([2, 3]);
      c.beginPath();
      c.roundRect(nx, yy + 1.5, nw, rh - 3, 3);
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(nx + 2, yy + rh / 2);
      c.lineTo(nx + nw - 2, yy + rh / 2);
      c.stroke();
      c.globalAlpha = 1;
    });

    // 提案（ゴースト）: 紫の枠。確からしい音は実線、誤検出かもしれない音は点線
    t.ghost?.notes.forEach((n, i) => {
      const yy = y(n.pitch);
      if (yy < T || n.step + n.len < this.startBar * 16 || n.step >= (this.startBar + this.viewBars) * 16) return;
      const conf = t.ghost!.conf[i] ?? 0.5;
      c.strokeStyle = v("--ghost");
      c.fillStyle = v("--ghost");
      c.globalAlpha = 0.1 + 0.2 * conf;
      c.beginPath();
      c.roundRect(L + (n.step - this.startBar * 16) * cw + 1.5, yy + 1.5, Math.max(drums ? 8 : 3, n.len * cw - 3), rh - 3, 3);
      c.fill();
      c.globalAlpha = 0.5 + 0.5 * conf;
      c.setLineDash(conf > 0.6 ? [] : [3, 3]);
      // AI が変えた・足した音は太い枠にする
      const isChanged = !!changed?.has(noteKey(n));
      c.lineWidth = isChanged ? 3 : 1.5;
      if (isChanged) c.globalAlpha = 1;
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    });

    // 矩形選択ボックス（Marquee Selection）
    if (this.drag && this.drag.mode === "box" && this.drag.moved) {
      const bx = Math.max(L, Math.min(this.drag.startX, this.drag.curX) - r.left);
      const by = Math.max(T, Math.min(this.drag.startY, this.drag.curY) - r.top);
      const bw = Math.abs(this.drag.curX - this.drag.startX);
      const bh = Math.abs(this.drag.curY - this.drag.startY);
      c.fillStyle = v("--accent-soft");
      c.fillRect(bx, by, bw, bh);
      c.strokeStyle = v("--accent");
      c.lineWidth = 1.2;
      c.setLineDash([4, 3]);
      c.strokeRect(bx + 0.5, by + 0.5, bw, bh);
      c.setLineDash([]);
    }

    if (this.hover && !this.drag && this.tool === "draw") {
      const yy = y(this.hover.pitch);
      const hoverLen = this.defaultLen ?? (this.snap || 1);
      const hoverW = Math.max(drums ? 8 : 4, hoverLen * cw - 1);
      c.strokeStyle = v("--muted");
      c.lineWidth = 1;
      c.strokeRect(L + (this.hover.step - this.startBar * 16) * cw + 0.5, yy + 0.5, hoverW, rh - 1);
    }

    // 左の鍵盤（ドラムは楽器名）
    c.fillStyle = drums ? v("--surface-2") : v("--key-white");
    c.fillRect(0, T, L, r.height - T);
    c.font = `11px ${font}`;
    c.textBaseline = "middle";
    const blackW = Math.round(L * 0.62);
    rows.forEach((row, i) => {
      const yy = T + i * rh;
      if (drums) {
        c.fillStyle = v("--text");
        c.fillText(row.label, 8, yy + rh / 2);
        c.fillStyle = v("--line");
        c.fillRect(0, yy + rh - 1, L, 1);
        return;
      }
      if (row.black) {
        c.fillStyle = v("--key-black");
        c.fillRect(0, yy, blackW, rh);
        c.fillStyle = v("--key-line");
        c.fillRect(blackW, Math.round(yy + rh / 2) - 0.5, L - blackW, 0.5);
      } else if (row.pitch % 12 === 0 || row.pitch % 12 === 5 || i === rows.length - 1) {
        c.fillStyle = v("--key-line");
        c.fillRect(0, Math.round(yy + rh) - 0.5, L, 0.5);
      }
      if (row.pitch % 12 === 0 && rh >= 8) {
        c.fillStyle = v("--key-black");
        c.textAlign = "right";
        c.fillText(`C${Math.floor(row.pitch / 12) - 1}`, L - 5, yy + rh / 2);
        c.textAlign = "left";
      }
    });
    c.fillStyle = v("--line");
    c.fillRect(L - 1, T, 1, r.height - T);

    // 上の小節の目盛り
    c.fillStyle = v("--ruler");
    c.fillRect(0, 0, r.width, T);
    c.fillStyle = v("--line");
    c.fillRect(0, T - 1, r.width, 1);
    c.font = `600 11px ${font}`;
    for (let b = 0; b < bars; b++) {
      const x = L + b * 16 * cw;
      c.fillStyle = v("--grid-bar");
      c.fillRect(Math.round(x), 0, 1, T);
      for (let q = 1; q < 4; q++) c.fillRect(Math.round(x + q * 4 * cw), T - 6, 1, 6);
      c.fillStyle = v("--text");
      c.fillText(String(this.startBar + b + 1), x + 5, T / 2);
    }
    if (this.playStep >= this.startBar * 16 && this.playStep < (this.startBar + this.viewBars) * 16) {
      const x = L + (this.playStep - this.startBar * 16) * cw;
      c.fillStyle = v("--playhead");
      c.beginPath();
      c.moveTo(x - 5, 2); c.lineTo(x + 5, 2); c.lineTo(x, 9); c.closePath();
      c.fill();
    }
  }
}
