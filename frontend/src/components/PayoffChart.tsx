import { useMemo, useState } from "react";
import { compact, nf } from "../lib/format";

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
}

const W = 900;
const H = 380;
const PAD = { l: 8, r: 8, t: 16, b: 22 };

export function PayoffChart({ x, expiryPnl, nowPnl, spot, breakevens, tPnl, symbol, tLabel }: Props) {
  const [hi, setHi] = useState<number | null>(null);

  const g = useMemo(() => {
    if (x.length < 2) return null;
    const xMin = x[0];
    const xMax = x[x.length - 1];
    const hasT = !!tPnl && tPnl.length === x.length;
    const yVals = [...expiryPnl, ...nowPnl, ...(hasT ? tPnl! : []), 0];
    let yMin = Math.min(...yVals);
    let yMax = Math.max(...yVals);
    const padY = (yMax - yMin) * 0.08 || 1;
    yMin -= padY;
    yMax += padY;

    const px = (v: number) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
    const py = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

    const line = (arr: number[]) => arr.map((v, i) => `${px(x[i])},${py(v)}`).join(" ");
    const area = (arr: number[], clampTop: boolean) => {
      const zeroY = py(0);
      const pts = arr.map((v, i) => {
        const yy = clampTop ? Math.min(py(v), zeroY) : Math.max(py(v), zeroY);
        return `${px(x[i])},${yy}`;
      });
      return `${px(xMin)},${zeroY} ${pts.join(" ")} ${px(xMax)},${zeroY}`;
    };

    const xTicks = Array.from({ length: 7 }, (_, i) => xMin + ((xMax - xMin) * i) / 6);
    const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);

    return { px, py, line, area, xTicks, yTicks, zeroY: py(0), xMin, xMax };
  }, [x, expiryPnl, nowPnl, tPnl]);

  if (!g) return <div className="p-6 text-sm text-term-dim">Add legs to see the payoff.</div>;

  const hasT = !!tPnl && tPnl.length === x.length;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const xv = g.xMin + frac * (g.xMax - g.xMin);
    // nearest sample
    let lo = 0;
    let bestD = Infinity;
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - xv);
      if (d < bestD) {
        bestD = d;
        lo = i;
      }
    }
    setHi(lo);
  };

  const cur = hi != null ? { k: x[hi], exp: expiryPnl[hi], now: nowPnl[hi], t: hasT ? tPnl![hi] : null } : null;
  const cursorFrac = cur ? (cur.k - g.xMin) / (g.xMax - g.xMin || 1) : 0;

  return (
    <div className="relative h-full w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full"
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHi(null)}
      >
        <polygon points={g.area(expiryPnl, true)} fill="#16a34a" opacity={0.14} />
        <polygon points={g.area(expiryPnl, false)} fill="#dc2626" opacity={0.14} />

        {g.yTicks.map((v, i) => (
          <g key={"y" + i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={g.py(v)} y2={g.py(v)} stroke="#141c27" />
            <text x={PAD.l + 2} y={g.py(v) - 2} fill="#5b6675" fontSize={10} className="num">
              {compact(v)}
            </text>
          </g>
        ))}
        {g.xTicks.map((v, i) => (
          <text
            key={"x" + i}
            x={g.px(v)}
            y={H - 6}
            fill="#5b6675"
            fontSize={10}
            textAnchor="middle"
            className="num"
          >
            {nf(v, 0)}
          </text>
        ))}

        <line x1={PAD.l} x2={W - PAD.r} y1={g.zeroY} y2={g.zeroY} stroke="#3b4657" strokeWidth={1} />

        <line x1={g.px(spot)} x2={g.px(spot)} y1={PAD.t} y2={H - PAD.b} stroke="#3b82f6" strokeDasharray="3 3" />
        <text x={g.px(spot) + 3} y={PAD.t + 10} fill="#3b82f6" fontSize={10} className="num">
          {nf(spot, 0)}
        </text>

        {breakevens.map((be, i) => (
          <g key={"be" + i}>
            <circle cx={g.px(be)} cy={g.zeroY} r={3} fill="#eab308" />
            <text x={g.px(be)} y={g.zeroY - 6} fill="#eab308" fontSize={10} textAnchor="middle" className="num">
              {nf(be, 0)}
            </text>
          </g>
        ))}

        <polyline points={g.line(nowPnl)} fill="none" stroke="#a855f7" strokeWidth={1.4} strokeDasharray="5 4" />
        {hasT && (
          <polyline points={g.line(tPnl!)} fill="none" stroke="#f59e0b" strokeWidth={1.8} />
        )}
        <polyline points={g.line(expiryPnl)} fill="none" stroke="#e2e8f0" strokeWidth={2} />

        {/* hover crosshair */}
        {cur && (
          <g>
            <line
              x1={g.px(cur.k)}
              x2={g.px(cur.k)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="#64748b"
              strokeWidth={1}
            />
            <circle cx={g.px(cur.k)} cy={g.py(cur.exp)} r={3.5} fill="#e2e8f0" />
            <circle cx={g.px(cur.k)} cy={g.py(cur.now)} r={3.5} fill="#a855f7" />
            {cur.t != null && <circle cx={g.px(cur.k)} cy={g.py(cur.t)} r={3.5} fill="#f59e0b" />}
          </g>
        )}
      </svg>

      {/* hover readout (HTML overlay so text stays crisp) */}
      {cur && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded border border-term-border bg-term-panel/95 px-2 py-1 text-[10px] leading-tight shadow-lg"
          style={{
            left: `${cursorFrac * 100}%`,
            transform: `translateX(${cursorFrac > 0.6 ? "-105%" : "8px"})`,
          }}
        >
          <div className="num font-semibold text-term-text">
            {symbol ? `${symbol} ` : ""}
            {nf(cur.k, 0)}
            <span className="ml-1 text-term-dim">
              ({cur.k >= spot ? "+" : ""}
              {nf(((cur.k - spot) / spot) * 100, 1)}%)
            </span>
          </div>
          <div className={`num ${cur.exp >= 0 ? "text-up" : "text-down"}`}>
            On expiry: ₹{nf(cur.exp, 0)}
          </div>
          <div className={`num ${cur.now >= 0 ? "text-up" : "text-down"}`}>
            Now (T+0): ₹{nf(cur.now, 0)}
          </div>
          {cur.t != null && (
            <div className={`num ${cur.t >= 0 ? "text-up" : "text-down"}`}>
              {tLabel ?? "T+n"}: ₹{nf(cur.t, 0)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
