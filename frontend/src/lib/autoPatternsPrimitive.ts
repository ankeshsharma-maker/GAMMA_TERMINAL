/** Draws the auto-detected ranges / chart patterns (lib/chartPatterns.ts) on the price
 *  pane -- boxes, lines (dashed = not confirmed) and small labels -- via the same
 *  lightweight-charts Series Primitives API as the drawing tools (chartDrawings.ts). */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { Shape } from "./chartPatterns";

type Px =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; color: string; dash: boolean; label?: string; flat: boolean }
  | { kind: "box"; x1: number; y1: number; x2: number; y2: number; color: string; label?: string; below?: boolean }
  | { kind: "text"; x: number; y: number; text: string; color: string; above: boolean };

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

class Renderer implements ISeriesPrimitivePaneRenderer {
  constructor(private _px: Px[]) {}
  draw(target: Parameters<ISeriesPrimitivePaneRenderer["draw"]>[0]): void {
    const px = this._px;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      // 1) the lines and boxes
      for (const s of px) {
        if (s.kind === "text") continue;
        ctx.save();
        if (s.kind === "box") {
          const x = Math.min(s.x1, s.x2);
          const y = Math.min(s.y1, s.y2);
          ctx.fillStyle = alpha(s.color, 0.1);
          ctx.fillRect(x, y, Math.max(2, Math.abs(s.x2 - s.x1)), Math.max(1, Math.abs(s.y2 - s.y1)));
          ctx.strokeStyle = alpha(s.color, 0.7);
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(x, y, Math.max(2, Math.abs(s.x2 - s.x1)), Math.max(1, Math.abs(s.y2 - s.y1)));
        } else {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 1.5;
          if (s.dash) ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 2) the labels, on top: each on a dark tag so it reads over candles, kept inside
      // the pane, and nudged up / down when it would sit on a label already placed.
      // A label whose anchor has scrolled off the left edge is skipped.
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const hits = (r: { x: number; y: number; w: number; h: number }) =>
        placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
      const tag = (text: string, cx: number, cy: number, color: string, bold = false, dir = -1) => {
        ctx.font = `${bold ? "bold " : ""}10px system-ui, sans-serif`;
        const w = ctx.measureText(text).width + 6;
        const h = 13;
        const x = Math.max(1, Math.min(cx - w / 2, W - w - 2));
        let y = cy - h / 2;
        for (let k = 0; k < 6 && hits({ x, y, w, h }); k++) y += dir * (h + 1);
        placed.push({ x, y, w, h });
        ctx.fillStyle = "rgba(13,17,23,0.85)";
        ctx.strokeStyle = alpha(color, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + 3, y + h / 2 + 0.5);
      };
      for (const s of px) {
        ctx.save();
        if (s.kind === "text") {
          // swing label: just above the high / below the low, clear of the wick
          if (s.x >= 0) tag(s.text, s.x, s.above ? s.y - 12 : s.y + 12, s.color, true, s.above ? -1 : 1);
        } else if (s.kind === "box") {
          const x = Math.min(s.x1, s.x2);
          const top = Math.min(s.y1, s.y2);
          const bot = Math.max(s.y1, s.y2);
          if (s.label && x >= 0) {
            ctx.font = "10px system-ui, sans-serif";
            const cx = x + ctx.measureText(s.label).width / 2 + 4;
            if (s.below) tag(s.label, cx, bot + 9, s.color, false, 1);
            else tag(s.label, cx, top - 9, s.color);
          }
        } else if (s.label) {
          if (s.flat) {
            // a level (ORH / neckline / BOS): on the line, in the middle of its run
            const x0 = Math.max(s.x1, 0);
            if (s.x2 > 20) tag(s.label, (x0 + s.x2) / 2, s.y1 - 8, s.color);
          } else if (s.x2 >= 0) {
            // a pattern name: above the peak / below the trough the leg ends on
            const peak = s.y2 < s.y1;
            tag(s.label, s.x2, peak ? s.y2 - 22 : s.y2 + 22, s.color, false, peak ? -1 : 1);
          }
        }
        ctx.restore();
      }
    });
  }
}

class View implements ISeriesPrimitivePaneView {
  private _px: Px[] = [];
  constructor(private _src: AutoPatternsPrimitive) {}
  update(): void {
    this._px = this._src.toPixels();
  }
  renderer(): ISeriesPrimitivePaneRenderer | null {
    return new Renderer(this._px);
  }
}

export class AutoPatternsPrimitive implements ISeriesPrimitive {
  private _views: View[];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<any> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _shapes: Shape[] = [];

  constructor() {
    this._views = [new View(this)];
  }
  attached(p: SeriesAttachedParameter): void {
    this._chart = p.chart as IChartApi;
    this._series = p.series as ISeriesApi<any>;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }
  updateAllViews(): void {
    this._views.forEach((v) => v.update());
  }
  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._views;
  }
  setShapes(shapes: Shape[]): void {
    this._shapes = shapes;
    this._requestUpdate?.();
  }

  toPixels(): Px[] {
    if (!this._chart || !this._series) return [];
    const ts = this._chart.timeScale();
    const X = (t: number) => ts.timeToCoordinate(t as Time);
    const Y = (p: number) => this._series!.priceToCoordinate(p);
    const out: Px[] = [];
    for (const s of this._shapes) {
      if (s.kind === "text") {
        const x = X(s.t);
        const y = Y(s.p);
        if (x == null || y == null) continue;
        out.push({ kind: "text", x, y, text: s.text, color: s.color, above: s.above });
        continue;
      }
      const x1 = X(s.t1);
      const x2 = X(s.t2);
      if (x1 == null || x2 == null) continue;
      if (s.kind === "box") {
        const y1 = Y(s.top);
        const y2 = Y(s.bottom);
        if (y1 == null || y2 == null) continue;
        out.push({ kind: "box", x1, y1, x2, y2, color: s.color, label: s.label, below: s.labelBelow });
      } else {
        const y1 = Y(s.p1);
        const y2 = Y(s.p2);
        if (y1 == null || y2 == null) continue;
        out.push({ kind: "line", x1, y1, x2, y2, color: s.color, dash: !!s.dash, label: s.label, flat: s.p1 === s.p2 });
      }
    }
    return out;
  }
}
