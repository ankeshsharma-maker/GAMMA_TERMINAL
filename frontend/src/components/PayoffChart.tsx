import { useMemo } from "react";
import { compact, nf } from "../lib/format";

interface Props {
  x: number[];
  expiryPnl: number[];
  nowPnl: number[];
  spot: number;
  breakevens: number[];
  /** optional intermediate "time to expiry" curve (T+n) */
  tPnl?: number[] | null;
}

const W = 900;
const H = 380;
const PAD = { l: 8, r: 8, t: 16, b: 22 };

export function PayoffChart({ x, expiryPnl, nowPnl, spot, breakevens, tPnl }: Props) {
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
      // polygon of the curve down/up to the zero line, for shading
      const zeroY = py(0);
      const pts = arr.map((v, i) => {
        const yy = clampTop ? Math.min(py(v), zeroY) : Math.max(py(v), zeroY);
        return `${px(x[i])},${yy}`;
      });
      return `${px(xMin)},${zeroY} ${pts.join(" ")} ${px(xMax)},${zeroY}`;
    };

    const xTicks = Array.from({ length: 7 }, (_, i) => xMin + ((xMax - xMin) * i) / 6);
    const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);

    return { px, py, line, area, xTicks, yTicks, zeroY: py(0) };
  }, [x, expiryPnl, nowPnl, tPnl]);

  if (!g) return <div className="p-6 text-sm text-term-dim">Add legs to see the payoff.</div>;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
      {/* profit / loss shading vs expiry curve */}
      <polygon points={g.area(expiryPnl, true)} fill="#16a34a" opacity={0.14} />
      <polygon points={g.area(expiryPnl, false)} fill="#dc2626" opacity={0.14} />

      {/* y grid + labels */}
      {g.yTicks.map((v, i) => (
        <g key={"y" + i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={g.py(v)} y2={g.py(v)} stroke="#141c27" />
          <text x={PAD.l + 2} y={g.py(v) - 2} fill="#5b6675" fontSize={10} className="num">
            {compact(v)}
          </text>
        </g>
      ))}
      {/* x labels */}
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

      {/* zero P/L line */}
      <line x1={PAD.l} x2={W - PAD.r} y1={g.zeroY} y2={g.zeroY} stroke="#3b4657" strokeWidth={1} />

      {/* spot marker */}
      <line x1={g.px(spot)} x2={g.px(spot)} y1={PAD.t} y2={H - PAD.b} stroke="#3b82f6" strokeDasharray="3 3" />
      <text x={g.px(spot) + 3} y={PAD.t + 10} fill="#3b82f6" fontSize={10} className="num">
        {nf(spot, 0)}
      </text>

      {/* breakevens */}
      {breakevens.map((be, i) => (
        <g key={"be" + i}>
          <circle cx={g.px(be)} cy={g.zeroY} r={3} fill="#eab308" />
          <text x={g.px(be)} y={g.zeroY - 6} fill="#eab308" fontSize={10} textAnchor="middle" className="num">
            {nf(be, 0)}
          </text>
        </g>
      ))}

      {/* curves */}
      <polyline points={g.line(nowPnl)} fill="none" stroke="#a855f7" strokeWidth={1.4} strokeDasharray="5 4" />
      {tPnl && tPnl.length === x.length && (
        <polyline points={g.line(tPnl)} fill="none" stroke="#f59e0b" strokeWidth={1.8} />
      )}
      <polyline points={g.line(expiryPnl)} fill="none" stroke="#e2e8f0" strokeWidth={2} />
    </svg>
  );
}
