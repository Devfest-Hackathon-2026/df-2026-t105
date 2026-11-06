import { trackRole } from "./state";
import { KEY_W } from "./roll";
import type { Note, Project, TrackId } from "./state";

/**
 * ベロシティ欄。ピアノロールと同じ横位置に、ノートごとの強さを縦棒で描く。
 * 棒の上をドラッグすると強さが変わり、離したときに onChange で確定する（元に戻すの対象になる）。
 */
export class VelocityLane {
  private ctx: CanvasRenderingContext2D;
  private drag: { pointerId: number; note: Note; vel: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private get: () => Project,
    private track: () => TrackId,
    private onChange: (track: TrackId, note: Note, vel: number) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", () => { this.drag = null; this.draw(); });
  }

  private geom() {
    const r = this.canvas.getBoundingClientRect();
    const steps = this.get().bars * 16;
    const cw = (r.width - KEY_W) / steps;
    return { r, steps, cw, pad: 6 };
  }

  private velAt(clientY: number) {
    const { r, pad } = this.geom();
    const h = r.height - pad * 2;
    return Math.max(0.05, Math.min(1, 1 - (clientY - r.top - pad) / h));
  }

  /** ポインターの列にあるノートのうち、棒の先端がポインターに一番近いもの */
  private pick(e: PointerEvent): Note | null {
    const { r, cw, pad } = this.geom();
    const step = Math.floor((e.clientX - r.left - KEY_W) / cw);
    const notes = this.get().tracks[this.track()].notes.filter((n) => n.step === step);
    if (!notes.length) return null;
    const h = r.height - pad * 2;
    const y = e.clientY - r.top;
    return notes.reduce((a, b) => (Math.abs(pad + h * (1 - a.vel) - y) <= Math.abs(pad + h * (1 - b.vel) - y) ? a : b));
  }

  private down(e: PointerEvent) {
    const n = this.pick(e);
    if (!n) return;
    this.drag = { pointerId: e.pointerId, note: n, vel: this.velAt(e.clientY) };
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  }
  private move(e: PointerEvent) {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.drag.vel = this.velAt(e.clientY);
      this.draw();
      return;
    }
    this.canvas.style.cursor = this.pick(e) ? "ns-resize" : "default";
  }
  private up(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const d = this.drag;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch {}
    this.onChange(this.track(), d.note, Math.round(d.vel * 100) / 100);
  }

  draw() {
    const dpr = devicePixelRatio || 1;
    const { r, steps, cw, pad } = this.geom();
    if (this.canvas.width !== Math.round(r.width * dpr) || this.canvas.height !== Math.round(r.height * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    const c = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    c.fillStyle = v("--surface-2");
    c.fillRect(0, 0, r.width, r.height);
    c.fillStyle = v("--muted");
    c.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    c.textBaseline = "middle";
    c.fillText("強さ", 8, r.height / 2);
    c.fillStyle = v("--line");
    c.fillRect(KEY_W - 1, 0, 1, r.height);
    for (let s = 0; s <= steps; s += 16) c.fillRect(Math.round(KEY_W + s * cw), 0, 1, r.height);

    const h = r.height - pad * 2;
    const t = this.get().tracks[this.track()];
    const bar = (n: Note, vel: number, color: string, alpha: number) => {
      const x = KEY_W + n.step * cw + Math.max(1, cw * 0.2);
      const w = Math.max(2, Math.min(cw * 0.6, 8));
      const top = pad + h * (1 - vel);
      c.globalAlpha = alpha;
      c.fillStyle = color;
      c.fillRect(x, top, w, r.height - pad - top);
      c.beginPath();
      c.arc(x + w / 2, top, Math.max(2, w / 2 + 0.5), 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    };
    for (const n of t.ghost?.notes ?? []) bar(n, n.vel, v("--ghost"), 0.35);
    const color = v(`--track-${trackRole(this.get(),this.track())}`);
    for (const n of t.notes) bar(n, this.drag?.note === n ? this.drag.vel : n.vel, color, 0.9);
  }
}
