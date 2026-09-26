import { useEffect, useMemo, useRef, useState } from "react";
import { compact, nf } from "../lib/format";

export interface OiRow {
  strike: number;
  call: number;
  put: number;
}

interface Props {
  x: number[];
  expiryPnl: number[];
  nowPnl: number[];
  spot: number;
  breakevens: number[];
  /** optional intermediate "time to expiry" curve (T+n) */
  tPnl?: number[] | null;
  /** underlying name for the hover readout (e.g. "NIFTY") */
  symbol?: string;
  /** label for the tPnl curve (e.g. "T+3d") */
  tLabel?: string;
  /** flat P&L offset (manual / booked) added to every curve */
  offset?: number;
  /** one standard deviation of the move to expiry, in points -- sizes the default window */
  sd?: number;
  /** margin, for the "projected profit (+x%)" badge */
  margin?: number;
  /** open interest per strike (calls / puts), drawn as bars behind the curves */
  oi?: OiRow[];
}

const PAD = { l: 56, r: 44, t: 30, b: 26 };
const UP = "#22c55e";
const DOWN = "#ef4444";
const TARGET = "#60a5fa";

/** a "nice" axis step (1 / 2 / 2.5 / 5 x 10^n) giving about `n` ticks over `span` */
const niceStep = (span: number, n: number) => {
  const raw = span / Math.max(1, n);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
};

/** Payoff chart laid out like Sensibull's: a window sized to the expected move (about 3 SD, and wide
 *  enough for the breakevens), Zoom in / out, the current price marked on top, the projected profit at
 *  the current price below, the expiry line green above zero / red below, the target-date curve in
 *  blue, and call / put open interest as bars behind it. */
export function PayoffChart(props: Props) {
  const { x, spot, breakevens, symbol, tLabel, sd, margin, oi } = props;
  const off = props.offset || 0;
  const expiryPnl = useMemo(() => (off ? props.expiryPnl.map((v) => v + off) : props.expiryPnl), [props.expiryPnl, off]);
  const nowPnl = useMemo(() => (off ? props.nowPnl.map((v) => v + off) : props.nowPnl), [props.nowPnl, off]);
  const tPnl = useMemo(
    () => (props.tPnl && off ? props.tPnl.map((v) => v + off) : props.tPnl),
    [props.tPnl, off]
  );
  const hasT = !!tPnl && tPnl.length === x.length;
  /** the blue "on target date" curve: the T+n one when a target is set, else today's */
  const target = hasT ? tPnl! : nowPnl;
  const [hi, setHi] = useState<number | null>(null);
  const [showOi, setShowOi] = useState(true);
  // drawn at its real on-screen size (a stretched viewBox squashed the labels to ~6 px on a laptop)
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 360 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: Math.max(240, el.clientWidth), h: Math.max(200, el.clientHeight) });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const W = box.w;
  const H = box.h;

  // ---- the visible window: default = Sensibull-style, then Zoom in / out around the spot ----
  const dataLo = x[0] ?? 0;
  const dataHi = x[x.length - 1] ?? 0;
  const defHalf = useMemo(() => {
    const farBe = breakevens.reduce((m, b) => Math.max(m, Math.abs(b - spot)), 0);
    const half = Math.max((sd ?? 0) * 3, farBe * 1.25, spot * 0.015);
    return Math.min(half, Math.max(spot - dataLo, dataHi - spot));
  }, [sd, breakevens, spot, dataLo, dataHi]);
  const [zoom, setZoom] = useState(1); // window = defHalf * zoom either side of the spot
  useEffect(() => setZoom(1), [symbol]);
  const maxZoom = Math.max(1, Math.max(spot - dataLo, dataHi - spot) / (defHalf || 1));
  const half = defHalf * zoom;
  const vLo = Math.max(dataLo, spot - half);
  const vHi = Math.min(dataHi, spot + half);

  const g = useMemo(() => {
    if (x.length < 2 || !(vHi > vLo)) return null;
    // the points inside the window, plus one either side so the lines reach the edges
    let i0 = 0;
    while (i0 < x.length - 1 && x[i0 + 1] < vLo) i0++;
    let i1 = x.length - 1;
    while (i1 > 0 && x[i1 - 1] > vHi) i1--;
    const idx = Array.from({ length: i1 - i0 + 1 }, (_, k) => i0 + k);
    const inWin = idx.filter((i) => x[i] >= vLo && x[i] <= vHi);
    const yVals = [...inWin.map((i) => expiryPnl[i]), ...inWin.map((i) => target[i]), 0];
    let yMin = Math.min(...yVals);
    let yMax = Math.max(...yVals);
    const padY = (yMax - yMin) * 0.1 || 1;
    yMin -= padY;
    yMax += padY;

    const px = (v: number) => PAD.l + ((v - vLo) / (vHi - vLo)) * (W - PAD.l - PAD.r);
    const py = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
    const line = (arr: number[]) => idx.map((i) => `${px(x[i])},${py(arr[i])}`).join(" ");
    const zeroY = py(0);
    const area = (arr: number[], above: boolean) => {
      const pts = idx.map((i) => `${px(x[i])},${above ? Math.min(py(arr[i]), zeroY) : Math.max(py(arr[i]), zeroY)}`);
      return `${px(x[idx[0]])},${zeroY} ${pts.join(" ")} ${px(x[idx[idx.length - 1]])},${zeroY}`;
    };

    const xs = niceStep(vHi - vLo, Math.max(3, Math.round(W / 110)));
    const xTicks: number[] = [];
    for (let v = Math.ceil(vLo / xs) * xs; v <= vHi; v += xs) xTicks.push(v);
    const ys = niceStep(yMax - yMin, Math.max(3, Math.round(H / 70)));
    const yTicks: number[] = [];
    for (let v = Math.ceil(yMin / ys) * ys; v <= yMax; v += ys) yTicks.push(v);

    // OI bars: the strikes in the window; bars rise from the zero line (from the floor when the zero
    // line sits too close to the top to leave them room), scaled to the biggest OI on screen
    const rows = (oi ?? []).filter((r) => r.strike >= vLo && r.strike <= vHi && (r.call > 0 || r.put > 0));
    const oiMax = rows.reduce((m, r) => Math.max(m, r.call, r.put), 0);
    const base = zeroY - PAD.t > (H - PAD.t - PAD.b) * 0.35 ? zeroY : H - PAD.b;
    const room = (base - PAD.t) * 0.6; // bars stay in the background: at most 60% of the height
    const stepPx = rows.length > 1 ? Math.min(...rows.slice(1).map((r, k) => px(r.strike) - px(rows[k].strike))) : 20;
    const barW = Math.max(2, Math.min(14, stepPx * 0.36));
    const oiY = (v: number) => base - (oiMax ? (v / oiMax) * room : 0);

    return { px, py, line, area, xTicks, yTicks, zeroY, rows, oiMax, oiY, base, barW, inWin };
  }, [x, expiryPnl, target, vLo, vHi, oi, W, H]);

  if (!g) return <div className="p-6 text-sm text-term-dim">Add legs to see the payoff.</div>;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const xv = vLo + ((sx - PAD.l) / (W - PAD.l - PAD.r)) * (vHi - vLo);
    let best = g.inWin[0] ?? 0;
    for (const i of g.inWin) if (Math.abs(x[i] - xv) < Math.abs(x[best] - xv)) best = i;
    setHi(best);
  };

  // the value at the spot, read off the curves (linear between the two nearest points)
  const at = (arr: number[], v: number) => {
    let j = 1;
    while (j < x.length - 1 && x[j] < v) j++;
    const f = (v - x[j - 1]) / (x[j] - x[j - 1] || 1);
    return arr[j - 1] + (arr[j] - arr[j - 1]) * Math.min(1, Math.max(0, f));
  };
  const projected = at(target, spot);
  const pct = margin && margin > 0 ? (projected / margin) * 100 : null;

  const cur = hi != null ? { k: x[hi], exp: expiryPnl[hi], tgt: target[hi] } : null;
  const cursorFrac = cur ? (g.px(cur.k) - 0) / W : 0;
  // OI readout: the strike under the cursor, else the one nearest the spot
  const oiRef = (() => {
    if (!g.rows.length) return null;
    const k = cur ? cur.k : spot;
    return g.rows.reduce((b, r) => (Math.abs(r.strike - k) < Math.abs(b.strike - k) ? r : b), g.rows[0]);
  })();
  const spotFrac = (g.px(spot) / W) * 100;
  const clipAbove = `clip-up-${Math.round(g.zeroY)}`;
  const clipBelow = `clip-dn-${Math.round(g.zeroY)}`;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {/* header: OI at a strike · legend · OI toggle · zoom */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pb-1 text-[11px]">
        {showOi && oiRef ? (
          <span className="text-term-dim">
            OI data at <b className="num text-term-text">{nf(oiRef.strike, 0)}</b>
            <span className="ml-3 inline-flex items-center gap-1">
              <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: DOWN }} />
              Call OI <b className="num text-term-text">{compact(oiRef.call)}</b>
            </span>
            <span className="ml-3 inline-flex items-center gap-1">
              <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: UP }} />
              Put OI <b className="num text-term-text">{compact(oiRef.put)}</b>
            </span>
          </span>
        ) : (
          <span />
        )}
        <span className="ml-auto flex items-center gap-3 text-term-dim">
          <span className="inline-flex items-center gap-1">
            <i className="inline-block h-[3px] w-5 rounded" style={{ background: `linear-gradient(90deg, ${UP} 50%, ${DOWN} 50%)` }} />
            On expiry
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block h-[3px] w-5 rounded" style={{ background: TARGET }} />
            {hasT ? tLabel ?? "On target date" : "Today"}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <button
            className={`btn px-2 py-0.5 text-[11px] ${showOi ? "border-term-accent text-term-accent" : ""}`}
            onClick={() => setShowOi((v) => !v)}
            title="Open interest per strike behind the payoff"
          >
            OI
          </button>
          <button
            className="btn px-2 py-0.5 text-[11px]"
            onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))}
            disabled={zoom <= 0.25}
            title="Zoom in (narrower price range)"
          >
            ＋ Zoom in
          </button>
          <button
            className="btn px-2 py-0.5 text-[11px]"
            onClick={() => setZoom((z) => Math.min(maxZoom, z * 1.5))}
            disabled={zoom >= maxZoom - 1e-6}
            title="Zoom out (wider price range)"
          >
            − Zoom out
          </button>
          {zoom !== 1 && (
            <button className="btn px-2 py-0.5 text-[11px]" onClick={() => setZoom(1)} title="Back to the default range">
              Reset
            </button>
          )}
        </span>
      </div>

      <div ref={boxRef} className="relative min-h-[220px] flex-1">
        {/* current price label, over the vertical line */}
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-term-border bg-term-panel px-2 py-0.5 text-[11px] font-semibold text-term-text"
          style={{ left: `${spotFrac}%` }}
        >
          Current price: <span className="num">{nf(spot, 2)}</span>
        </div>

        <svg
          width={W}
          height={H}
          className="absolute inset-0"
          onMouseMove={onMove}
          onMouseLeave={() => setHi(null)}
        >
          <defs>
            <clipPath id={clipAbove}>
              <rect x={0} y={0} width={W} height={Math.max(0, g.zeroY)} />
            </clipPath>
            <clipPath id={clipBelow}>
              <rect x={0} y={g.zeroY} width={W} height={Math.max(0, H - g.zeroY)} />
            </clipPath>
          </defs>

          {/* grid + axes */}
          {g.yTicks.map((v) => (
            <g key={"y" + v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={g.py(v)} y2={g.py(v)} stroke="#1a2330" />
              <text x={PAD.l - 6} y={g.py(v) + 3} fill="#7a8699" fontSize={11} textAnchor="end" className="num">
                {compact(v)}
              </text>
            </g>
          ))}
          {g.xTicks.map((v) => (
            <text key={"x" + v} x={g.px(v)} y={H - 8} fill="#7a8699" fontSize={11} textAnchor="middle" className="num">
              {nf(v, 0)}
            </text>
          ))}

          {/* open interest bars (behind everything else) */}
          {showOi &&
            g.oiMax > 0 &&
            g.rows.map((r) => (
              <g key={"oi" + r.strike}>
                <rect
                  x={g.px(r.strike) - g.barW}
                  y={g.oiY(r.put)}
                  width={g.barW}
                  height={Math.max(0, g.base - g.oiY(r.put))}
                  fill={UP}
                  opacity={0.26}
                />
                <rect
                  x={g.px(r.strike)}
                  y={g.oiY(r.call)}
                  width={g.barW}
                  height={Math.max(0, g.base - g.oiY(r.call))}
                  fill={DOWN}
                  opacity={0.26}
                />
              </g>
            ))}
          {showOi && g.oiMax > 0 && (
            <>
              <text x={W - PAD.r + 6} y={g.oiY(g.oiMax) + 4} fill="#7a8699" fontSize={10} className="num">
                {compact(g.oiMax)}
              </text>
              <text x={W - PAD.r + 6} y={g.base + 4} fill="#7a8699" fontSize={10} className="num">
                0
              </text>
            </>
          )}

          {/* profit / loss areas under the expiry line */}
          <polygon points={g.area(expiryPnl, true)} fill={UP} opacity={0.1} />
          <polygon points={g.area(expiryPnl, false)} fill={DOWN} opacity={0.14} />
          <line x1={PAD.l} x2={W - PAD.r} y1={g.zeroY} y2={g.zeroY} stroke="#3b4657" strokeWidth={1} />

          {/* current price */}
          <line x1={g.px(spot)} x2={g.px(spot)} y1={PAD.t - 6} y2={H - PAD.b} stroke="#94a3b8" strokeWidth={1} />

          {/* breakevens */}
          {breakevens
            .filter((b) => b >= vLo && b <= vHi)
            .map((be) => (
              <g key={"be" + be}>
                <circle cx={g.px(be)} cy={g.zeroY} r={3.5} fill="#eab308" />
                <text x={g.px(be)} y={g.zeroY + 15} fill="#eab308" fontSize={10.5} textAnchor="middle" className="num">
                  {nf(be, 0)}
                </text>
              </g>
            ))}

          {/* the target-date (or today's) curve, then the expiry line: green above zero, red below */}
          <polyline points={g.line(target)} fill="none" stroke={TARGET} strokeWidth={2.2} />
          <polyline points={g.line(expiryPnl)} fill="none" stroke={UP} strokeWidth={2.4} clipPath={`url(#${clipAbove})`} />
          <polyline points={g.line(expiryPnl)} fill="none" stroke={DOWN} strokeWidth={2.4} clipPath={`url(#${clipBelow})`} />

          {/* hover crosshair */}
          {cur && (
            <g>
              <line x1={g.px(cur.k)} x2={g.px(cur.k)} y1={PAD.t} y2={H - PAD.b} stroke="#64748b" strokeDasharray="3 3" />
              <circle cx={g.px(cur.k)} cy={g.py(cur.exp)} r={3.5} fill={cur.exp >= 0 ? UP : DOWN} />
              <circle cx={g.px(cur.k)} cy={g.py(cur.tgt)} r={3.5} fill={TARGET} />
            </g>
          )}
        </svg>

        {/* hover readout (HTML so the text stays crisp) */}
        {cur && (
          <div
            className="pointer-events-none absolute top-8 z-10 rounded border border-term-border bg-term-panel/95 px-2 py-1 text-[11px] leading-tight shadow-lg"
            style={{ left: `${cursorFrac * 100}%`, transform: `translateX(${cursorFrac > 0.6 ? "-105%" : "8px"})` }}
          >
            <div className="num font-semibold text-term-text">
              {symbol ? `${symbol} ` : ""}
              {nf(cur.k, 0)}
              <span className="ml-1 text-term-dim">
                ({cur.k >= spot ? "+" : ""}
                {nf(((cur.k - spot) / spot) * 100, 1)}%)
              </span>
            </div>
            <div className={`num ${cur.exp >= 0 ? "text-up" : "text-down"}`}>On expiry: ₹{nf(cur.exp, 0)}</div>
            <div className="num" style={{ color: TARGET }}>
              {hasT ? tLabel ?? "Target" : "Today"}: ₹{nf(cur.tgt, 0)}
            </div>
          </div>
        )}
      </div>

      {/* projected profit at the current price, like Sensibull's badge under the chart */}
      <div className="flex justify-center pt-1">
        <span
          className={`num rounded px-3 py-1 text-[12px] font-semibold ${
            projected >= 0 ? "bg-up/20 text-up" : "bg-down/20 text-down"
          }`}
          title={`P&L at the current price ${hasT ? `on ${tLabel ?? "the target date"}` : "today"} (model value)`}
        >
          Projected {projected >= 0 ? "profit" : "loss"}: ₹{nf(Math.abs(projected), 0)}
          {pct != null && ` (${pct >= 0 ? "+" : ""}${nf(pct, 1)}%)`}
        </span>
      </div>
    </div>
  );
}
