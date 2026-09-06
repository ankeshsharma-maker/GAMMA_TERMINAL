import { useEffect, useMemo, useState } from "react";
import { RangePresets } from "./RangePresets";
import { useStore } from "../store";
import { api } from "../lib/api";
import { lakhs, nf } from "../lib/format";

type Row = {
  date: string;
  spot: number | null;
  ceOI: number;
  peOI: number;
  pcr: number | null;
  maxPain: number | null;
  dSpot?: number;
  dOI?: number;
  state?: string;
};

const STATE_CLS: Record<string, string> = {
  "LONG BUILDUP": "text-up",
  "SHORT BUILDUP": "text-down",
  "LONG UNWINDING": "text-amber-400",
  "SHORT COVERING": "text-sky-400",
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Historical daily chain metrics over a date range — spot, total Call/Put OI,
 *  PCR, max-pain and the day-over-day OI state. Data from Upstox
 *  (/api/upstox/history-chain); needs Upstox connected (index or F&O stock). */
export function OIHistory() {
  const symbol = useStore((s) => s.symbol);
  const chain = useStore((s) => s.chain);
  const expiry = useStore((s) => s.expiry) ?? chain?.expiry ?? "";

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return iso(d);
  });
  const [to, setTo] = useState(() => iso(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    if (!expiry) {
      setErr("pick an expiry first");
      return;
    }
    setBusy(true);
    setErr(null);
    api.upstoxHistoryChain(symbol, expiry, from, to).then(
      (d) => {
        setRows((d.series as Row[]) ?? []);
        setBusy(false);
      },
      (e) => {
        setErr(e?.message || "failed");
        setRows([]);
        setBusy(false);
      }
    );
  };

  // auto-load when the pane opens and whenever the symbol / expiry changes
  useEffect(() => {
    setRows([]);
    setErr(null);
    if (!expiry) return;
    setBusy(true);
    let alive = true;
    api.upstoxHistoryChain(symbol, expiry, from, to).then(
      (d) => {
        if (!alive) return;
        setRows((d.series as Row[]) ?? []);
        setBusy(false);
      },
      (e) => {
        if (!alive) return;
        setErr(e?.message || "failed");
        setBusy(false);
      }
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, expiry]);

  const chart = useMemo(() => {
    if (rows.length < 2) return null;
    const W = 1000;
    const H = 320;
    const pad = { l: 54, r: 52, t: 12, b: 22 };
    const spots = rows.map((r) => r.spot ?? 0).filter(Boolean);
    const haveSpot = spots.length > 0;
    const ois = rows.flatMap((r) => [r.ceOI, r.peOI]);
    let slo = haveSpot ? Math.min(...spots) : 0;
    let shi = haveSpot ? Math.max(...spots) : 1;
    const sp = (shi - slo) * 0.1 || 1;
    slo -= sp;
    shi += sp;
    const omax = Math.max(...ois, 1) * 1.1;
    const x = (i: number) => pad.l + (i / (rows.length - 1)) * (W - pad.l - pad.r);
    const ys = (v: number) => pad.t + (1 - (v - slo) / (shi - slo || 1)) * (H - pad.t - pad.b);
    const yo = (v: number) => pad.t + (1 - v / omax) * (H - pad.t - pad.b);
    const bw = ((W - pad.l - pad.r) / rows.length) * 0.32;
    const spotPath = rows
      .map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${ys(r.spot ?? slo).toFixed(1)}`)
      .join(" ");
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={pad.t + f * (H - pad.t - pad.b)}
              y2={pad.t + f * (H - pad.t - pad.b)}
              stroke="currentColor"
              strokeOpacity={0.1}
              className="text-term-dim"
            />
            <text x={4} y={pad.t + f * (H - pad.t - pad.b) + 3} fontSize={10} className="fill-term-dim">
              {lakhs(omax * (1 - f))}
            </text>
            <text
              x={W - pad.r + 4}
              y={pad.t + f * (H - pad.t - pad.b) + 3}
              fontSize={10}
              className="fill-sky-400/80"
            >
              {nf(shi - f * (shi - slo), 0)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={i}>
            <rect
              x={x(i) - bw - 1}
              y={yo(r.ceOI)}
              width={bw}
              height={H - pad.b - yo(r.ceOI)}
              fill="#f87171"
              opacity={0.75}
            />
            <rect
              x={x(i) + 1}
              y={yo(r.peOI)}
              width={bw}
              height={H - pad.b - yo(r.peOI)}
              fill="#4ade80"
              opacity={0.75}
            />
          </g>
        ))}
        {haveSpot && <path d={spotPath} fill="none" stroke="#38bdf8" strokeWidth={2} />}
        {rows.map((r, i) =>
          i % Math.ceil(rows.length / 6) === 0 ? (
            <text key={"t" + i} x={x(i)} y={H - 6} fontSize={9} textAnchor="middle" className="fill-term-dim">
              {r.date.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    );
  }, [rows]);

  const dOISum = rows.reduce((s, r) => s + (r.dOI ?? 0), 0);
  const spotMove =
    rows.length >= 2 ? (rows[rows.length - 1].spot ?? 0) - (rows[0].spot ?? 0) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        <span className="font-semibold uppercase tracking-wide">OI History</span>
        <span className="num font-semibold text-term-text">{symbol}</span>
        <span className="num">{expiry || "—"}</span>
        <label className="flex items-center gap-1">
          from
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <label className="flex items-center gap-1">
          to
          <input
            type="date"
            value={to}
            min={from}
            max={iso(new Date())}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text"
          />
        </label>
        <RangePresets set={(f, t) => (setFrom(f), setTo(t))} active={from} />
        <button
          onClick={load}
          disabled={busy}
          className="rounded bg-term-accent px-2 py-0.5 font-semibold text-white disabled:opacity-40"
        >
          {busy ? "loading…" : "Load"}
        </button>
        <span className="ml-auto">
          <span className="text-[#f87171]">■</span> Call OI &nbsp;
          <span className="text-[#4ade80]">■</span> Put OI &nbsp;
          <span className="text-sky-400">─</span> Spot
        </span>
      </div>

      {err && <div className="border-b border-term-border px-3 py-1.5 text-2xs text-down">{err}</div>}

      {rows.length >= 2 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-term-border bg-term-panel px-3 py-1.5 text-2xs">
          <span className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase text-term-dim">Spot move (range)</span>
            <span className={`num text-sm font-semibold ${spotMove >= 0 ? "text-up" : "text-down"}`}>
              {spotMove >= 0 ? "+" : ""}
              {nf(spotMove, 0)}
            </span>
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase text-term-dim">Net OI added (range)</span>
            <span className={`num text-sm font-semibold ${dOISum >= 0 ? "text-term-text" : "text-amber-400"}`}>
              {lakhs(dOISum)}
            </span>
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase text-term-dim">Latest PCR</span>
            <span className="num text-sm font-semibold">
              {rows[rows.length - 1].pcr != null ? nf(rows[rows.length - 1].pcr!, 2) : "–"}
            </span>
          </span>
        </div>
      )}

      <div className="h-[240px] shrink-0 p-3">
        {chart ? (
          <div className="h-full w-full">{chart}</div>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-xs text-term-dim">
            {busy
              ? "pulling historical OI from Upstox…"
              : err
              ? "no chart — see the message above"
              : rows.length === 1
              ? "only one day in range — widen the date range"
              : "Pick a date range and hit Load. Needs Upstox connected (index or F&O stock)."}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto border-t border-term-border">
          <table className="w-full border-separate border-spacing-0 text-2xs">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                {["Date", "Spot", "ΔSpot", "Call OI", "Put OI", "PCR", "Max Pain", "OI State"].map((h) => (
                  <th key={h} className="border-b border-term-border px-3 py-1 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.date}>
                  <td className="num border-b border-term-border/40 px-3 py-1 text-term-dim">{r.date}</td>
                  <td className="num border-b border-term-border/40 px-3 py-1">{nf(r.spot ?? 0, 0)}</td>
                  <td
                    className={`num border-b border-term-border/40 px-3 py-1 ${
                      (r.dSpot ?? 0) >= 0 ? "text-up" : "text-down"
                    }`}
                  >
                    {r.dSpot != null ? `${r.dSpot >= 0 ? "+" : ""}${nf(r.dSpot, 0)}` : "–"}
                  </td>
                  <td className="num border-b border-term-border/40 px-3 py-1" style={{ color: "#f87171" }}>
                    {lakhs(r.ceOI)}
                  </td>
                  <td className="num border-b border-term-border/40 px-3 py-1" style={{ color: "#4ade80" }}>
                    {lakhs(r.peOI)}
                  </td>
                  <td className="num border-b border-term-border/40 px-3 py-1">
                    {r.pcr != null ? nf(r.pcr, 2) : "–"}
                  </td>
                  <td className="num border-b border-term-border/40 px-3 py-1">
                    {r.maxPain != null ? nf(r.maxPain, 0) : "–"}
                  </td>
                  <td
                    className={`border-b border-term-border/40 px-3 py-1 font-semibold ${
                      STATE_CLS[r.state ?? ""] ?? "text-term-dim"
                    }`}
                  >
                    {r.state ?? "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
