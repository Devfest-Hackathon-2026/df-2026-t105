import { DRUM_ROWS, RANGE, type Note, type Project, type TrackId } from "./state";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = [1, 3, 6, 8, 10];
/** これだけ動いたらドラッグ（移動・リサイズ）、動かなければクリック（削除）とみなす距離（px） */
const CLICK_RADIUS = 4;

/** ピアノロール。本物のノートは塗り、ゴーストは確信度に応じた濃さの枠で描く */
export class Roll {
  private ctx: CanvasRenderingContext2D;
  track: TrackId = "lead";
  playStep = -1;
  private hover: { step: number; pitch: number } | null = null;
  private labelW = 44;
  /** ドラッグ中の状態。next はドラッグ先のノートで、pointerup で onEdit に渡す */
  private drag: {
    pointerId: number;
    mode: "move" | "resize";
    note: Note;
    startX: number;
    startY: number;
    origStep: number;
    origLen: number;
    origRow: number;
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
    canvas.addEventListener("pointercancel", () => this.cancelDrag());
    // ドラッグ中に Esc が押されたら取り消す
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.cancelDrag();
    });
  }

  private rows(): { pitch: number; label: string; black: boolean }[] {
    if (this.track === "drums") return DRUM_ROWS.map((r) => ({ pitch: r.pitch, label: r.name, black: false }));
    const [lo, hi] = RANGE[this.track];
    const out = [];
    for (let p = hi; p >= lo; p--) out.push({ pitch: p, label: p % 12 === 0 || p === hi ? `${NAMES[p % 12]}${Math.floor(p / 12) - 1}` : "", black: BLACK.includes(p % 12) });
    return out;
  }

  private geom() {
    const r = this.canvas.getBoundingClientRect();
    const rows = this.rows();
    const steps = this.get().bars * 16;
    const cw = (r.width - this.labelW) / steps;
    const rh = r.height / rows.length;
    return { r, rows, steps, cw, rh };
  }

  private hit(e: PointerEvent) {
    const { r, rows, steps, cw, rh } = this.geom();
    const x = e.clientX - r.left - this.labelW, y = e.clientY - r.top;
    if (x < 0) return null;
    const step = Math.floor(x / cw), row = Math.floor(y / rh);
    if (step < 0 || step >= steps || row < 0 || row >= rows.length) return null;
    return { step, pitch: rows[row].pitch };
  }

  /** ポインターの下にあるものを調べる。自分のノートのときは右端（長さ変更のつかみ位置）かどうかも返す */
  private probe(e: PointerEvent):
    | { kind: "outside" }
    | { kind: "empty" }
    | { kind: "ghost"; note: Note }
    | { kind: "note"; note: Note; edge: boolean } {
    const { r, rows, steps, cw, rh } = this.geom();
    const x = e.clientX - r.left - this.labelW, y = e.clientY - r.top;
    if (x < 0) return { kind: "outside" };
    const step = Math.floor(x / cw), row = Math.floor(y / rh);
    if (step < 0 || step >= steps || row < 0 || row >= rows.length) return { kind: "outside" };
    const pitch = rows[row].pitch;
    const t = this.get().tracks[this.track];
    const covers = (n: Note) => n.pitch === pitch && step >= n.step && step < n.step + n.len;
    const ghost = t.ghost?.notes.find(covers);
    if (ghost) return { kind: "ghost", note: ghost };
    const real = t.notes.find(covers);
    if (!real) return { kind: "empty" };
    // 右端のつかみ幅。幅 24px 未満の短いノートは幅の 25%、それ以外は 6px。ドラムは長さを変えない
    const w = real.len * cw;
    const grip = w < 24 ? w * 0.25 : 6;
    const edge = this.track !== "drums" && x >= (real.step + real.len) * cw - grip;
    return { kind: "note", note: real, edge };
  }

  private onPointerDown(e: PointerEvent) {
    if (this.drag) return; // すでにドラッグ中（2本目の指など）は無視
    const p = this.probe(e);
    if (p.kind === "ghost") {
      // ゴーストは従来どおり、その場で採用・消去
      this.onEdit(e.button === 2 ? "reject" : "accept", this.track, p.note);
      return;
    }
    if (p.kind !== "note") {
      const h = this.hit(e);
      if (h && e.button === 0) this.onEdit("add", this.track, { step: h.step, len: this.track === "drums" ? 1 : 2, pitch: h.pitch, vel: 0.8 });
      return;
    }
    // 自分のノート。4px 以上動いたらドラッグ、動かずに離したらクリック（削除）と後で判別する
    e.preventDefault();
    const { rows } = this.geom();
    this.drag = {
      pointerId: e.pointerId,
      mode: p.edge ? "resize" : "move",
      note: p.note,
      startX: e.clientX,
      startY: e.clientY,
      origStep: p.note.step,
      origLen: p.note.len,
      origRow: rows.findIndex((row) => row.pitch === p.note.pitch),
      next: { ...p.note },
      moved: false,
    };
    // ポインターキャプチャでキャンバスの外に出てもドラッグを続ける
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = p.edge ? "ew-resize" : "grab";
    this.hover = null;
    this.draw();
  }

  private onPointerMove(e: PointerEvent) {
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const dx = e.clientX - this.drag.startX, dy = e.clientY - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) >= CLICK_RADIUS) this.drag.moved = true;
      if (this.drag.moved) this.updateNext(dx, dy);
      this.canvas.style.cursor = this.drag.mode === "resize" ? "ew-resize" : this.drag.moved ? "grabbing" : "grab";
      this.draw();
      return;
    }
    this.hover = this.hit(e);
    this.updateCursor(e);
    this.draw();
  }

  /** ポインターの移動量からドラッグ先のノートを作る。クランプは main.ts の onEdit と同じ */
  private updateNext(dx: number, dy: number) {
    if (!this.drag) return;
    const { rows, steps, cw, rh } = this.geom();
    const d = this.drag;
    if (d.mode === "move") {
      const step = Math.max(0, Math.min(steps - 1, d.origStep + Math.round(dx / cw)));
      const row = Math.max(0, Math.min(rows.length - 1, d.origRow + Math.round(dy / rh)));
      d.next = { ...d.note, step, pitch: rows[row].pitch };
    } else {
      const len = Math.max(1, Math.min(steps - d.origStep, d.origLen + Math.round(dx / cw)));
      d.next = { ...d.note, len };
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch {}
    if (d.moved) {
      const changed = d.next.step !== d.note.step || d.next.len !== d.note.len || d.next.pitch !== d.note.pitch;
      if (changed) this.onEdit(d.mode, this.track, d.note, d.next);
    } else {
      // 動かずに離したらクリック扱いで消す（従来の動作）
      this.onEdit("remove", this.track, d.note);
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

  /** ポインターの下にあるものに合わせてカーソルを変える */
  private updateCursor(e: PointerEvent) {
    const p = this.probe(e);
    this.canvas.style.cursor =
      p.kind === "outside" ? "default" : p.kind === "ghost" ? "pointer" : p.kind === "empty" ? "crosshair" : p.edge ? "ew-resize" : "grab";
  }

  draw() {
    const dpr = devicePixelRatio || 1;
    const { r, rows, steps, cw, rh } = this.geom();
    if (this.canvas.width !== Math.round(r.width * dpr)) { this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr); }
    const c = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const L = this.labelW;

    rows.forEach((row, i) => {
      c.fillStyle = row.black ? v("--roll-black") : v("--roll-white");
      c.fillRect(L, i * rh, r.width - L, rh);
      c.fillStyle = v("--muted");
      c.font = "11px ui-monospace, monospace";
      c.textBaseline = "middle";
      if (row.label) c.fillText(row.label, 6, i * rh + rh / 2);
    });
    for (let s = 0; s <= steps; s++) {
      c.fillStyle = s % 16 === 0 ? v("--grid-bar") : s % 4 === 0 ? v("--grid-beat") : v("--grid");
      c.fillRect(L + s * cw - (s % 16 === 0 ? 1 : 0.5), 0, s % 16 === 0 ? 2 : 1, r.height);
    }
    if (this.playStep >= 0) {
      c.fillStyle = v("--playhead");
      c.fillRect(L + this.playStep * cw, 0, cw, r.height);
    }
    const y = (p: number) => rows.findIndex((row) => row.pitch === p) * rh;
    const t = this.get().tracks[this.track];
    /** ノートを1個描く。mul で薄くできる（ドラッグ元のプレビュー用） */
    const note = (n: Note, mul = 1) => {
      const yy = y(n.pitch);
      if (yy < 0) return;
      c.fillStyle = v("--note");
      c.globalAlpha = (0.55 + 0.45 * n.vel) * mul;
      c.beginPath();
      c.roundRect(L + n.step * cw + 1, yy + 1, n.len * cw - 2, rh - 2, 3);
      c.fill();
      c.globalAlpha = 1;
    };
    for (const n of t.notes) {
      if (this.drag && n === this.drag.note) continue; // ドラッグ中の元のノートは下で薄く描く
      note(n);
    }
    if (this.drag) {
      note(this.drag.note, 0.25); // 元の位置は薄く
      note(this.drag.next); // 新しい位置は通常色でライブプレビュー
    }
    t.ghost?.notes.forEach((n, i) => {
      const yy = y(n.pitch);
      if (yy < 0) return;
      const conf = t.ghost!.conf[i] ?? 0.5;
      c.strokeStyle = v("--ghost");
      c.fillStyle = v("--ghost");
      c.globalAlpha = 0.12 + 0.25 * conf;
      c.beginPath();
      c.roundRect(L + n.step * cw + 1.5, yy + 1.5, n.len * cw - 3, rh - 3, 3);
      c.fill();
      c.globalAlpha = 0.45 + 0.55 * conf;
      c.setLineDash(conf > 0.6 ? [] : [3, 3]);
      c.lineWidth = 1.5;
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    });
    if (this.hover && !this.drag) {
      const yy = y(this.hover.pitch);
      c.strokeStyle = v("--muted");
      c.strokeRect(L + this.hover.step * cw + 0.5, yy + 0.5, cw - 1, rh - 1);
    }
  }
}
