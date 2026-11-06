import { DRUM_ROWS, trackRole, trackRange, type Note, type Project, type TrackId } from "./state";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = [1, 3, 6, 8, 10];
/** これだけ動いたらドラッグ（移動・リサイズ）、動かなければクリック（削除）とみなす距離（px） */
const CLICK_RADIUS = 4;
/** 左の鍵盤の幅と、上の小節の目盛りの高さ。テイクのレーンとベロシティ欄もこの幅を空けて列をそろえる */
export const KEY_W = 112;
export const RULER_H = 22;

/** ピアノロール。本物のノートは塗り、ゴーストは確信度に応じた濃さの枠で描く */
export class Roll {
  private ctx: CanvasRenderingContext2D;
  track: TrackId = "lead";
  playStep = -1;
  startBar = 0;
  viewBars = 4;
  snap = .25;
  private hover: { step: number; pitch: number } | null = null;
  private labelW = KEY_W;
  /** 鍵盤をクリックしたときに音を鳴らす */
  onAudition: (pitch: number) => void = () => {};
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
    if (trackRole(this.get(),this.track) === "drums") {
      const t=this.get().tracks[this.track];
      const pitches=[...new Set([...DRUM_ROWS.map((r)=>r.pitch),...t.notes.map((n)=>n.pitch),...(t.ghost?.notes.map((n)=>n.pitch)??[])])].sort((a,b)=>a-b);
      return pitches.map((pitch)=>({pitch,label:DRUM_ROWS.find((r)=>r.pitch===pitch)?.name??`Drum ${pitch}`,black:false}));
    }
    const [lo, hi] = trackRange(this.get(),this.track);
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

  private hit(e: PointerEvent) {
    const { r, rows, steps, cw, rh } = this.geom();
    const x = e.clientX - r.left - this.labelW, y = e.clientY - r.top - RULER_H;
    if (x < 0) return null;
    const step = Math.floor(x / cw / (this.snap||1/960))*(this.snap||1/960), row = Math.floor(y / rh);
    if (step < 0 || step >= steps || row < 0 || row >= rows.length) return null;
    return { step:step+this.startBar*16, pitch: rows[row].pitch };
  }

  /** ポインターの下にあるものを調べる。自分のノートのときは右端（長さ変更のつかみ位置）かどうかも返す */
  private probe(e: PointerEvent):
    | { kind: "outside" }
    | { kind: "empty" }
    | { kind: "ghost"; note: Note }
    | { kind: "note"; note: Note; edge: boolean } {
    const { r, rows, steps, cw, rh } = this.geom();
    const x = e.clientX - r.left - this.labelW, y = e.clientY - r.top - RULER_H;
    if (x < 0 || y < 0) return { kind: "outside" };
    const step = x / cw, row = Math.floor(y / rh);
    if (step < 0 || step >= steps || row < 0 || row >= rows.length) return { kind: "outside" };
    const pitch = rows[row].pitch;
    const t = this.get().tracks[this.track];
    const covers = (n: Note) => n.pitch === pitch && step+this.startBar*16 >= n.step && step+this.startBar*16 < n.step + Math.max(n.len,3/cw);
    const ghost = t.ghost?.notes.find(covers);
    if (ghost) return { kind: "ghost", note: ghost };
    const real = t.notes.find(covers);
    if (!real) return { kind: "empty" };
    // 右端のつかみ幅。幅 24px 未満の短いノートは幅の 25%、それ以外は 6px。ドラムは長さを変えない
    const w = real.len * cw;
    const grip = w < 24 ? w * 0.25 : 6;
    const edge = trackRole(this.get(),this.track) !== "drums" && x >= (real.step-this.startBar*16 + real.len) * cw - grip;
    return { kind: "note", note: real, edge };
  }

  private onPointerDown(e: PointerEvent) {
    if (this.drag) return; // すでにドラッグ中（2本目の指など）は無視
    {
      // 左の鍵盤を押したら、その高さの音を鳴らす
      const { r, rows, rh } = this.geom();
      const x = e.clientX - r.left, y = e.clientY - r.top - RULER_H;
      if (x < this.labelW && y >= 0) {
        const row = rows[Math.floor(y / rh)];
        if (row) this.onAudition(row.pitch);
        return;
      }
    }
    const p = this.probe(e);
    if (p.kind === "ghost") {
      // ゴーストは従来どおり、その場で採用・消去
      this.onEdit(e.button === 2 ? "reject" : "accept", this.track, p.note);
      return;
    }
    if (p.kind !== "note") {
      const h = this.hit(e);
      if (h && e.button === 0) this.onEdit("add", this.track, { step: h.step, len: this.snap||.25, pitch: h.pitch, vel: 0.8 });
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
    const { rows, cw, rh } = this.geom();
    const d = this.drag;
    if (d.mode === "move") {
      const delta=this.snap?Math.round(dx/cw/this.snap)*this.snap:dx/cw;
      const step = Math.max(0,d.origStep+delta);
      const row = Math.max(0, Math.min(rows.length - 1, d.origRow + Math.round(dy / rh)));
      d.next = { ...d.note, step, pitch: rows[row].pitch };
    } else {
      const delta=this.snap?Math.round(dx/cw/this.snap)*this.snap:dx/cw;
      const len = Math.max(this.snap||1/960,d.origLen+delta);
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
    const r = this.canvas.getBoundingClientRect();
    const onKeys = e.clientX - r.left < this.labelW && e.clientY - r.top > RULER_H;
    this.canvas.style.cursor = onKeys
      ? "pointer"
      : p.kind === "outside" ? "default" : p.kind === "ghost" ? "pointer" : p.kind === "empty" ? "crosshair" : p.edge ? "ew-resize" : "grab";
  }

  draw() {
    const rowCount=this.rows().length;
    const parentHeight=this.canvas.parentElement?.clientHeight??260;
    const height=Math.max(parentHeight,RULER_H+rowCount*(trackRole(this.get(),this.track)==="drums"?26:16));
    if(this.canvas.style.height!==`${height}px`)this.canvas.style.height=`${height}px`;
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
    const drums = trackRole(this.get(),this.track) === "drums";
    const bars = steps / 16;

    // 行の背景（黒鍵の行は少し沈める）
    rows.forEach((row, i) => {
      c.fillStyle = row.black ? v("--roll-black") : v("--roll-white");
      c.fillRect(L, T + i * rh, r.width - L, rh);
    });
    // 縦の格子: 16分、拍、小節
    for (let s = 0; s <= steps+.0001; s+=this.snap||.25) {
      const bar = Math.abs(s/16-Math.round(s/16))<.00001, beat = Math.abs(s/4-Math.round(s/4))<.00001;
      c.fillStyle = bar ? v("--grid-bar") : beat ? v("--grid-beat") : v("--grid");
      c.fillRect(Math.round(L + s * cw) - (bar ? 1 : 0), T, bar ? 1.5 : 1, r.height - T);
    }
    // オクターブの境目（C の上）に横線
    if (!drums) {
      c.fillStyle = v("--grid-beat");
      rows.forEach((row, i) => { if (row.pitch % 12 === 11) c.fillRect(L, T + i * rh, r.width - L, 1); });
    }
    // 再生位置
    if (this.playStep >= this.startBar*16 && this.playStep < (this.startBar+this.viewBars)*16) {
      c.fillStyle = v("--playhead-soft");
      c.fillRect(L + (this.playStep-this.startBar*16) * cw, T, cw, r.height - T);
      c.fillStyle = v("--playhead");
      c.fillRect(L + (this.playStep-this.startBar*16) * cw, T, 1.5, r.height - T);
    }

    const y = (p: number) => T + rows.findIndex((row) => row.pitch === p) * rh;
    const t = this.get().tracks[this.track];
    const noteColor = v(`--track-${trackRole(this.get(),this.track)}`);
    /** ノートを1個描く。mul で薄くできる（ドラッグ元のプレビュー用） */
    const note = (n: Note, mul = 1) => {
      const yy = y(n.pitch);
      if (yy < T || n.step+n.len<this.startBar*16 || n.step>=(this.startBar+this.viewBars)*16) return;
      c.fillStyle = noteColor;
      c.globalAlpha = (0.6 + 0.4 * n.vel) * mul;
      c.beginPath();
      c.roundRect(L + (n.step-this.startBar*16) * cw + 1, yy + 1, Math.max(3, n.len * cw - 2), rh - 2, 3);
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
    // 提案（ゴースト）: 紫の枠。確からしい音は実線、誤検出かもしれない音は点線
    t.ghost?.notes.forEach((n, i) => {
      const yy = y(n.pitch);
      if (yy < T || n.step+n.len<this.startBar*16 || n.step>=(this.startBar+this.viewBars)*16) return;
      const conf = t.ghost!.conf[i] ?? 0.5;
      c.strokeStyle = v("--ghost");
      c.fillStyle = v("--ghost");
      c.globalAlpha = 0.1 + 0.2 * conf;
      c.beginPath();
      c.roundRect(L + (n.step-this.startBar*16) * cw + 1.5, yy + 1.5, Math.max(3, n.len * cw - 3), rh - 3, 3);
      c.fill();
      c.globalAlpha = 0.5 + 0.5 * conf;
      c.setLineDash(conf > 0.6 ? [] : [3, 3]);
      c.lineWidth = 1.5;
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    });
    if (this.hover && !this.drag) {
      const yy = y(this.hover.pitch);
      c.strokeStyle = v("--muted");
      c.lineWidth = 1;
      c.strokeRect(L + (this.hover.step-this.startBar*16) * cw + 0.5, yy + 0.5, cw - 1, rh - 1);
    }

    // Left labels mask notes extending from earlier bars.
    // 左の鍵盤（ドラムは楽器名）
    c.fillStyle = v("--surface-2");
    c.fillRect(0, T, L, r.height - T);
    c.font = `11px ${font}`;
    c.textBaseline = "middle";
    rows.forEach((row, i) => {
      const yy = T + i * rh;
      if (drums) {
        c.fillStyle = v("--text");
        c.fillText(row.label, 8, yy + rh / 2);
        c.fillStyle = v("--line");
        c.fillRect(0, yy + rh - 1, L, 1);
        return;
      }
      c.fillStyle = row.black ? v("--key-black") : v("--key-white");
      c.fillRect(0, yy, row.black ? L * 0.62 : L, rh);
      if (row.black) {
        c.fillStyle = v("--key-white");
        c.fillRect(L * 0.62, yy, L * 0.38, rh);
      }
      c.fillStyle = v("--key-line");
      c.fillRect(0, yy + rh - 0.5, L, 0.5);
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
      c.fillText(String(this.startBar+b + 1), x + 5, T / 2);
    }
    if (this.playStep >= this.startBar*16 && this.playStep < (this.startBar+this.viewBars)*16) {
      const x = L + (this.playStep-this.startBar*16) * cw;
      c.fillStyle = v("--playhead");
      c.beginPath();
      c.moveTo(x - 5, 2); c.lineTo(x + 5, 2); c.lineTo(x, 9); c.closePath();
      c.fill();
    }
  }
}
