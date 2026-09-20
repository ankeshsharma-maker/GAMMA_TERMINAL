import { useEffect, useMemo, useRef, useState } from "react";

/** Small dependency-free SVG line chart: several series on a shared numeric x axis,
 *  nice ticks, optional vertical / horizontal reference lines, and a hover crosshair
 *  with a value readout. Used where lightweight-charts (time series only) doesn't fit --
 *  IV vs strike, IV vs days-to-expiry, realized vol over dates. */

export type LinePoint = { x: number; y: number };
export type LineSeries = {
  key: string;
  label: string;
  color: string;
  points: LinePoint[];
  dashed?: boolean;
  width?: number;
  dots?: boolean;
};
export type RefLine = { value: number; label?: string; color?: string; dashed?: boolean };

/** 1-2-5 tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const M = { l: 46, r: 12, t: 12, b: 24 };

export function LineChart({
  series,
  height = 250,
  xFormat = (x) => String(x),
  yFormat = (y) => String(y),
  xTicks,
  vlines = [],
  hlines = [],
}: {
  series: LineSeries[];
  height?: number;
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  xTicks?: number[];
  vlines?: RefLine[];
  hlines?: RefLine[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const pts = series.flatMap((s) => s.points);
    if (!pts.length) return null;
    let x0 = Math.min(...pts.map((p) => p.x));
    let x1 = Math.max(...pts.map((p) => p.x));
    if (x1 === x0) {
      x0 -= 1;
      x1 += 1;
    }
    const ys = [...pts.map((p) => p.y), ...hlines.map((h) => h.value)];
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.1;
    y0 -= pad;
    y1 += pad;
    const xsAll = [...new Set(pts.map((p) => p.x))].sort((a, b) => a - b);
    return { x0, x1, y0, y1, xsAll };
  }, [series, hlines]);

  if (!geom) {
    return (
      <div className="flex items-center justify-center text-xs text-term-dim" style={{ height }}>
        No data
      </div>
    );
  }
  const { x0, x1, y0, y1, xsAll } = geom;
  const iw = Math.max(50, w - M.l - M.r);
  const ih = height - M.t - M.b;
  const sx = (x: number) => M.l + ((x - x0) / (x1 - x0)) * iw;
  const sy = (y: number) => M.t + (1 - (y - y0) / (y1 - y0)) * ih;
  const yt = niceTicks(y0, y1, 5);
  const xt = xTicks ?? niceTicks(x0, x1, Math.max(2, Math.floor(iw / 95)));

  const at = (clientX: number, rect: DOMRect) => {
    // as a fraction of the svg's own width, then in our css-px space: correct whatever the
    // page zoom is (the app's Interface scale sets CSS zoom, which skews raw client coords)
    const px = ((clientX - rect.left) / rect.width) * w;
    const x = x0 + ((px - M.l) / iw) * (x1 - x0);
    let best = xsAll[0];
    for (const v of xsAll) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
    setHoverX(best);
  };

  const readout =
    hoverX == null
      ? null
      : series
          .map((s) => {
            const p = s.points.reduce<LinePoint | null>(
              (b, q) => (b == null || Math.abs(q.x - hoverX) < Math.abs(b.x - hoverX) ? q : b),
              null
            );
            return p && Math.abs(p.x - hoverX) <= (x1 - x0) * 0.04 ? { s, y: p.y } : null;
          })
          .filter((r): r is { s: LineSeries; y: number } => r != null);
  const hx = hoverX == null ? 0 : sx(hoverX);

  return (
    // min-w-0 + overflow-hidden + max-width:100% keep the svg from ever widening its container:
    // it is sized from the container's width, so a fixed pixel width here would otherwise pin the
    // parent grid column (and on a phone the whole page) at whatever width it was first measured at
    <div ref={wrapRef} className="relative w-full min-w-0 select-none overflow-hidden" style={{ height }}>
      <svg
        width={w}
        height={height}
        className="block"
        style={{ maxWidth: "100%" }}
        onMouseMove={(e) => at(e.clientX, e.currentTarget.getBoundingClientRect())}
        onTouchMove={(e) => at(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHoverX(null)}
      >
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={M.l} x2={M.l + iw} y1={sy(v)} y2={sy(v)} className="stroke-term-border" strokeWidth={0.6} />
            <text x={M.l - 6} y={sy(v) + 3} textAnchor="end" className="fill-term-dim" fontSize={10}>
              {yFormat(v)}
            </text>
          </g>
        ))}
        {xt.map((v) => {
          // keep the label inside the drawing: a tick at either end anchors its text inward
          const lbl = xFormat(v);
          const half = lbl.length * 2.9;
          const px = sx(v);
          const anchor = px + half > w - 2 ? "end" : px - half < 2 ? "start" : "middle";
          return (
            <g key={`x${v}`}>
              <line x1={px} x2={px} y1={M.t} y2={M.t + ih} className="stroke-term-border/50" strokeWidth={0.5} />
              <text x={px} y={height - 8} textAnchor={anchor} className="fill-term-dim" fontSize={10}>
                {lbl}
              </text>
            </g>
          );
        })}

        {vlines.map((l, i) => (
          <g key={`v${i}`}>
            <line
              x1={sx(l.value)}
              x2={sx(l.value)}
              y1={M.t}
              y2={M.t + ih}
              stroke={l.color ?? "#3b82f6"}
              strokeWidth={1}
              strokeDasharray={l.dashed === false ? undefined : "4 3"}
            />
            {l.label && (
              <text x={sx(l.value) + 4} y={M.t + 10} fill={l.color ?? "#3b82f6"} fontSize={10}>
                {l.label}
              </text>
            )}
          </g>
        ))}
        {hlines.map((l, i) => (
          <g key={`h${i}`}>
            <line
              x1={M.l}
              x2={M.l + iw}
              y1={sy(l.value)}
              y2={sy(l.value)}
              stroke={l.color ?? "#eab308"}
              strokeWidth={1}
              strokeDasharray={l.dashed === false ? undefined : "5 3"}
            />
            {l.label && (
              <text x={M.l + iw - 4} y={sy(l.value) - 4} textAnchor="end" fill={l.color ?? "#eab308"} fontSize={10}>
                {l.label}
              </text>
            )}
          </g>
        ))}

        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => a.x - b.x);
          const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
          return (
            <g key={s.key}>
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width ?? 1.8}
                strokeDasharray={s.dashed ? "5 3" : undefined}
                strokeLinejoin="round"
              />
              {s.dots &&
                pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={s.color} />)}
            </g>
          );
        })}

        {hoverX != null && (
          <>
            <line x1={hx} x2={hx} y1={M.t} y2={M.t + ih} className="stroke-term-dim" strokeWidth={0.8} strokeDasharray="2 2" />
            {readout?.map(({ s, y }) => (
              <circle key={s.key} cx={hx} cy={sy(y)} r={3.5} fill={s.color} stroke="#0f141d" strokeWidth={1} />
            ))}
          </>
        )}
      </svg>

      {hoverX != null && readout && readout.length > 0 && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded border border-term-border bg-term-panel/95 px-2 py-1 text-[10px] shadow-lg"
          style={hx > w / 2 ? { right: w - hx + 8 } : { left: hx + 8 }}
        >
          <div className="mb-0.5 font-semibold text-term-text">{xFormat(hoverX)}</div>
          {readout.map(({ s, y }) => (
            <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap num">
              <span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: s.color }} />
              <span className="text-term-dim">{s.label}</span>
              <span className="ml-auto pl-2 text-term-text">{yFormat(y)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
