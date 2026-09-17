/** Trendline / Fib-retracement drawing primitives for Chart.tsx, built on
 * lightweight-charts v4's Series Primitives API (ISeriesPrimitive) -- the
 * horizontal-line tool stays on the older createPriceLine API (Chart.tsx),
 * since that's still the simplest correct tool for a pure horizontal; this
 * file only covers the two-point, arbitrary-angle tools createPriceLine
 * can't express. */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

export type Point = { time: number; price: number };

export type Drawing =
  | { id: string; type: "trend"; p1: Point; p2: Point }
  | { id: string; type: "fib"; p1: Point; p2: Point }
  | { id: string; type: "hline"; price: number };

/** The two-point tools a DrawingPrimitive can render. `hline` is drawn via the
 * older createPriceLine API instead (see Chart.tsx) -- no primitive needed
 * for a pure horizontal, so it's excluded here rather than handled as a
 * degenerate zero-length segment. */
export type LineDrawing = Extract<Drawing, { type: "trend" | "fib" }>;

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
const TREND_COLOR = "#eab308"; // same yellow as the existing horizontal-line tool
const FIB_COLOR = "#22d3ee"; // cyan, matches this file's MTF-overlay convention

type Segment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label?: string;
};

class SegmentsRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private _segments: Segment[]) {}
  draw(target: Parameters<ISeriesPrimitivePaneRenderer["draw"]>[0]): void {
    const segments = this._segments;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const s of segments) {
        ctx.save();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        if (s.label) {
          ctx.fillStyle = s.color;
          ctx.font = "10px system-ui, sans-serif";
          ctx.fillText(s.label, s.x2 + 4, s.y1 - 3);
        }
        ctx.restore();
      }
    });
  }
}

class DrawingPaneView implements ISeriesPrimitivePaneView {
  private _segments: Segment[] = [];
  constructor(private _source: DrawingPrimitive) {}
  update(): void {
    this._segments = this._source.computeSegments();
  }
  renderer(): ISeriesPrimitivePaneRenderer | null {
    return new SegmentsRenderer(this._segments);
  }
}

/** One primitive per drawing. Handles both trend and fib via `computeSegments` --
 * the two tools are the same "N segments between two anchor points" shape, just
 * with a different segment list, so one class covers both rather than splitting
 * into parallel Trend/Fib classes. */
export class DrawingPrimitive implements ISeriesPrimitive {
  private _paneViews: DrawingPaneView[];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<any> | null = null;
  private _requestUpdate: (() => void) | null = null;

  constructor(public drawing: LineDrawing) {
    this._paneViews = [new DrawingPaneView(this)];
  }

  attached(param: SeriesAttachedParameter): void {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<any>;
    this._requestUpdate = param.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }
  updateAllViews(): void {
    this._paneViews.forEach((v) => v.update());
  }
  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._paneViews;
  }

  /** Mutate the anchor points in place (used for the live drag preview) and
   * ask the chart to redraw -- avoids detach/reattach churn on every
   * pointermove. */
  setDrawing(d: LineDrawing): void {
    this.drawing = d;
    this._requestUpdate?.();
  }

  computeSegments(): Segment[] {
    if (!this._chart || !this._series) return [];
    const ts = this._chart.timeScale();
    const toXY = (p: Point) => ({
      x: ts.timeToCoordinate(p.time as Time),
      y: this._series!.priceToCoordinate(p.price),
    });
    const a = toXY(this.drawing.p1);
    const b = toXY(this.drawing.p2);
    if (a.x == null || a.y == null || b.x == null || b.y == null) return [];

    if (this.drawing.type === "trend") {
      return [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: TREND_COLOR }];
    }

    const { p1, p2 } = this.drawing;
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const segs: Segment[] = [];
    for (const level of FIB_LEVELS) {
      const price = p1.price + (p2.price - p1.price) * level;
      const y = this._series.priceToCoordinate(price);
      if (y == null) continue;
      segs.push({
        x1,
        y1: y,
        x2,
        y2: y,
        color: FIB_COLOR,
        label: `${(level * 100).toFixed(1)}%  ${price.toFixed(1)}`,
      });
    }
    return segs;
  }
}

export function describeDrawing(d: Drawing): string {
  const fmt = (p: Point) => p.price.toFixed(1);
  if (d.type === "hline") return `H-Line ${d.price.toFixed(2)}`;
  return d.type === "trend"
    ? `Trendline ${fmt(d.p1)} → ${fmt(d.p2)}`
    : `Fib ${fmt(d.p1)} → ${fmt(d.p2)}`;
}
