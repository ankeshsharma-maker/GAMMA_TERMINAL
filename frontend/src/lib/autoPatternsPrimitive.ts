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
  | { kind: "box"; x1: number; y1: number; x2: number; y2: number; color: string; label?: string };

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

class Renderer implements ISeriesPrimitivePaneRenderer {
  constructor(private _px: Px[]) {}
  draw(target: Parameters<ISeriesPrimitivePaneRenderer["draw"]>[0]): void {
    const px = this._px;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.font = "10px system-ui, sans-serif";
      // keep a label inside the pane: slide it left when it would run off the right edge
      const fitX = (x: number, text: string) => Math.max(2, Math.min(x, mediaSize.width - ctx.measureText(text).width - 4));
      for (const s of px) {
        ctx.save();
        if (s.kind === "box") {
          const x = Math.min(s.x1, s.x2);
          const y = Math.min(s.y1, s.y2);
          const w = Math.max(2, Math.abs(s.x2 - s.x1));
          const h = Math.max(1, Math.abs(s.y2 - s.y1));
          ctx.fillStyle = alpha(s.color, 0.1);
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = alpha(s.color, 0.7);
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(x, y, w, h);
          if (s.label) {
            ctx.fillStyle = s.color;
            ctx.fillText(s.label, fitX(x + 2, s.label), y - 3);
          }
        } else {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 1.5;
          if (s.dash) ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
          if (s.label) {
            ctx.fillStyle = s.color;
            // a level (ORH / neckline) is named at its left end; a pattern leg at its far end
            if (s.flat) ctx.fillText(s.label, fitX(s.x1 + 2, s.label), s.y1 - 3);
            else ctx.fillText(s.label, fitX(s.x2 + 3, s.label), s.y2 + (s.y2 < s.y1 ? -4 : 11));
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
      const x1 = X(s.t1);
      const x2 = X(s.t2);
      if (x1 == null || x2 == null) continue;
      if (s.kind === "box") {
        const y1 = Y(s.top);
        const y2 = Y(s.bottom);
        if (y1 == null || y2 == null) continue;
        out.push({ kind: "box", x1, y1, x2, y2, color: s.color, label: s.label });
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
