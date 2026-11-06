import { DRUM_ROWS, RANGE, type Note, type Project, type TrackId } from "./state";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = [1, 3, 6, 8, 10];

/** ピアノロール。本物のノートは塗り、ゴーストは確信度に応じた濃さの枠で描く */
export class Roll {
  private ctx: CanvasRenderingContext2D;
  track: TrackId = "lead";
  playStep = -1;
  private hover: { step: number; pitch: number } | null = null;
  private labelW = 44;

  constructor(
    private canvas: HTMLCanvasElement,
    private get: () => Project,
    private onEdit: (kind: "add" | "remove" | "accept" | "reject", track: TrackId, note: Note) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointermove", (e) => { this.hover = this.hit(e); this.draw(); });
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => this.click(e));
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

  private click(e: PointerEvent) {
    const h = this.hit(e);
    if (!h) return;
    const t = this.get().tracks[this.track];
    const covers = (n: Note) => n.pitch === h.pitch && h.step >= n.step && h.step < n.step + n.len;
    const ghost = t.ghost?.notes.find(covers);
    if (ghost) {
      this.onEdit(e.button === 2 ? "reject" : "accept", this.track, ghost);
      return;
    }
    const real = t.notes.find(covers);
    if (real) this.onEdit("remove", this.track, real);
    else if (e.button === 0) this.onEdit("add", this.track, { step: h.step, len: this.track === "drums" ? 1 : 2, pitch: h.pitch, vel: 0.8 });
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
    for (const n of t.notes) {
      const yy = y(n.pitch);
      if (yy < 0) continue;
      c.fillStyle = v("--note");
      c.globalAlpha = 0.55 + 0.45 * n.vel;
      c.beginPath();
      c.roundRect(L + n.step * cw + 1, yy + 1, n.len * cw - 2, rh - 2, 3);
      c.fill();
      c.globalAlpha = 1;
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
    if (this.hover) {
      const yy = y(this.hover.pitch);
      c.strokeStyle = v("--muted");
      c.strokeRect(L + this.hover.step * cw + 0.5, yy + 0.5, cw - 1, rh - 1);
    }
  }
}
