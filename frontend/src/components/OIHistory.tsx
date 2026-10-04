import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RangePresets } from "./RangePresets";
import { useStore } from "../store";
import { api } from "../lib/api";
import { crores, oiCr, nf } from "../lib/format";
import { useIsMobile } from "../lib/useIsMobile";
import { OIPhoneHeader, type OiView } from "./OIPhoneHeader";

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
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (s: string) => `${s.slice(8, 10)} ${MON[parseInt(s.slice(5, 7), 10) - 1]}`;

/** Historical daily chain metrics over a date range — spot, total Call/Put OI,
 *  PCR, max-pain and the day-over-day OI state. Data from Upstox
 *  (/api/upstox/history-chain); needs Upstox connected (index or F&O stock). */
/** `paneNav`: the OI Profile / Option Chain / History switch, riding this toolbar on the web */
export function OIHistory({ paneNav, onGoto }: { paneNav?: ReactNode; onGoto?: (v: OiView) => void } = {}) {
  const isMobile = useIsMobile();
  const [openDate, setOpenDate] = useState<string | null>(null);
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
  // the chart is drawn at its real pixel size (it used to be stretched to the box, which distorted the axis text)
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 200 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: Math.max(300, el.clientWidth - 24), h: Math.max(140, el.clientHeight - 12) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const emptyMsg =
    loaded && !busy && !err && rows.length === 0
      ? `No option-contract history for ${expiry || "this expiry"} in ${from} → ${to}. Weekly contracts only trade a few weeks — try a recent range or a monthly expiry.`
      : null;

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
        setLoaded(true);
        setBusy(false);
      },
      (e) => {
        setErr(e?.message || "failed");
        setRows([]);
        setLoaded(true);
        setBusy(false);
      }
    );
  };

  // auto-load when the pane opens and whenever the symbol / expiry changes
  useEffect(() => {
    setRows([]);
    setErr(null);
    setLoaded(false);
    if (!expiry) return;
    setBusy(true);
    let alive = true;
    api.upstoxHistoryChain(symbol, expiry, from, to).then(
      (d) => {
        if (!alive) return;
        setRows((d.series as Row[]) ?? []);
        setLoaded(true);
        setBusy(false);
      },
      (e) => {
        if (!alive) return;
        setErr(e?.message || "failed");
        setLoaded(true);
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
    const H = box.h;
    const spotsAll = rows.map((r) => r.spot ?? 0).filter(Boolean);
    // few days: keep each day's slot narrow (the chart hugs its bars) instead of spreading 4 days over the whole screen
    const SLOT = 96;
    const pad = { l: 50, r: spotsAll.length ? 52 : 12, t: 10, b: 20 };
    const W = Math.min(box.w, pad.l + pad.r + rows.length * SLOT);
    const spots = rows.map((r) => r.spot ?? 0).filter(Boolean);
    const haveSpot = spots.length > 0;
    const ois = rows.flatMap((r) => [r.ceOI, r.peOI]);
    let slo = haveSpot ? Math.min(...spots) : 0;
    let shi = haveSpot ? Math.max(...spots) : 1;
    const sp = (shi - slo) * 0.1 || 1;
    slo -= sp;
    shi += sp;
    const omax = Math.max(...ois, 1) * 1.1;
    const x = (i: number) => pad.l + ((i + 0.5) / rows.length) * (W - pad.l - pad.r);
    const ys = (v: number) => pad.t + (1 - (v - slo) / (shi - slo || 1)) * (H - pad.t - pad.b);
    const yo = (v: number) => pad.t + (1 - v / omax) * (H - pad.t - pad.b);
    const bw = Math.min(26, ((W - pad.l - pad.r) / rows.length) * 0.34);
    // one unit for the whole OI axis, so the ticks read 0 / 5.4 / 10.7 ... Cr and never mix Cr with L
    const [unit, suffix] = omax >= 1e7 ? [1e7, "Cr"] : [1e5, "L"];
    const oiTick = (v: number) => `${(v / unit).toFixed(omax / unit >= 20 ? 0 : 1)}${suffix}`;
    const spotPath = rows
      .map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${ys(r.spot ?? slo).toFixed(1)}`)
      .join(" ");
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block">
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
            <text x={pad.l - 6} y={pad.t + f * (H - pad.t - pad.b) + 3} fontSize={10} textAnchor="end" className="fill-term-dim">
              {oiTick(omax * (1 - f))}
            </text>
            {haveSpot && (
            <text
              x={W - pad.r + 4}
              y={pad.t + f * (H - pad.t - pad.b) + 3}
              fontSize={10}
              className="fill-sky-400/80"
            >
              {nf(shi - f * (shi - slo), 0)}
            </text>
            )}
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
          i % Math.ceil(rows.length / Math.max(3, Math.floor(W / 90))) === 0 ? (
            <text key={"t" + i} x={x(i)} y={H - 5} fontSize={10} textAnchor="middle" className="fill-term-dim">
              {dmy(r.date)}
            </text>
          ) : null
        )}
      </svg>
    );
  }, [rows, box]);

  const dOISum = rows.reduce((s, r) => s + (r.dOI ?? 0), 0);
  const spotMove =
    rows.length >= 2 && rows[rows.length - 1].spot && rows[0].spot ? (rows[rows.length - 1].spot ?? 0) - (rows[0].spot ?? 0) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isMobile && onGoto ? (
        <div className="px-2 pt-1.5">
          <OIPhoneHeader active="history" onView={(v) => v !== "history" && onGoto(v)}>
        <label className="flex items-center gap-1">
          from
          <input
            type="date"
            style={{ colorScheme: "dark" }}
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
            style={{ colorScheme: "dark" }}
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
          </OIPhoneHeader>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel2 px-3 py-1.5 text-2xs text-term-dim">
        {!paneNav && <span className="hidden font-semibold uppercase tracking-wide sm:inline">OI History</span>}
        <span className="num font-semibold text-term-text">{symbol}</span>
        <span className="num">{expiry || "—"}</span>
        {/* the OI Profile / Option Chain / History switch: after the symbol and expiry, as on the other two views */}
        {paneNav}
        <label className="flex items-center gap-1">
          from
          <input
            type="date"
            style={{ colorScheme: "dark" }}
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
            style={{ colorScheme: "dark" }}
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
        <span className="ml-auto hidden sm:inline">
          <span className="text-[#f87171]">■</span> Call OI &nbsp;
          <span className="text-[#4ade80]">■</span> Put OI &nbsp;
          <span className="text-sky-400">─</span> Spot
        </span>
      </div>
      )}

      {err && <div className="border-b border-term-border px-3 py-1.5 text-2xs text-down">{err}</div>}
      {emptyMsg && (
        <div className="border-b border-term-border px-3 py-1.5 text-2xs text-amber-400">{emptyMsg}</div>
      )}

      {rows.length >= 2 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-term-border bg-term-panel px-3 py-1.5 text-2xs">
          <span className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase text-term-dim">Spot move (range)</span>
            <span className={`num text-sm font-semibold ${spotMove == null ? "text-term-dim" : spotMove >= 0 ? "text-up" : "text-down"}`}>
              {spotMove == null ? "–" : `${spotMove >= 0 ? "+" : "−"}${nf(Math.abs(spotMove), 0)}`}
            </span>
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase text-term-dim">Net OI added (range)</span>
            <span className={`num text-sm font-semibold ${dOISum >= 0 ? "text-term-text" : "text-amber-400"}`}>
              {crores(dOISum)}
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

      <div ref={boxRef} className="h-[210px] shrink-0 overflow-hidden px-3 pb-1 pt-2">
        {chart ? (
          <div className="flex justify-center">{chart}</div>
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

      {rows.length > 0 && isMobile && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <table className="grid-table text-[12px]">
            <thead className="sticky top-0 bg-term-panel2 text-[10px] uppercase text-term-dim">
              <tr>
                {["Date", "Spot", "PCR", "Δ OI", "State"].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1 font-medium ${i === 0 || i === 4 ? "text-left" : "text-right"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => {
                const open = openDate === r.date;
                return (
                  <Fragment key={r.date}>
                    <tr onClick={() => setOpenDate(open ? null : r.date)} className={`cursor-pointer ${open ? "bg-term-panel2" : ""}`}>
                      <td className="num px-1.5 py-1.5 text-term-dim">
                        <span className="text-[9px] opacity-60">{open ? "▾ " : "▸ "}</span>
                        {r.date.slice(5)}
                      </td>
                      <td className="num px-1.5 py-1.5 text-right">{nf(r.spot ?? 0, 0)}</td>
                      <td className="num px-1.5 py-1.5 text-right">{r.pcr != null ? nf(r.pcr, 2) : "–"}</td>
                      <td className={`num px-1.5 py-1.5 text-right ${(r.dOI ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                        {r.dOI != null ? `${r.dOI >= 0 ? "+" : "−"}${oiCr(Math.abs(r.dOI))}` : "–"}
                      </td>
                      <td className={`px-1.5 py-1.5 font-semibold ${STATE_CLS[r.state ?? ""] ?? "text-term-dim"}`}>{r.state ? r.state.split(" ").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ") : "–"}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={5} className="bg-term-panel px-2 py-2 text-[12px] text-term-dim">
                          Call OI <b className="text-down">{crores(r.ceOI)}</b> · Put OI <b className="text-up">{crores(r.peOI)}</b> · Max pain{" "}
                          <b className="text-term-text">{r.maxPain != null ? nf(r.maxPain, 0) : "–"}</b> · Δ spot{" "}
                          <b className={(r.dSpot ?? 0) >= 0 ? "text-up" : "text-down"}>
                            {r.dSpot != null ? `${r.dSpot >= 0 ? "+" : ""}${nf(r.dSpot, 0)}` : "–"}
                          </b>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="mt-1.5 text-center text-[11px] text-term-dim">Tap a day for Call OI, Put OI, max pain and the spot move</div>
        </div>
      )}

      {rows.length > 0 && !isMobile && (
        <div className="min-h-0 flex-1 overflow-auto border-t border-term-border">
          <table className="mx-auto w-full max-w-[1000px] border-collapse text-[12px]">
            <thead className="sticky top-0 bg-term-panel text-[10px] uppercase text-term-dim">
              <tr>
                {["Date", "Spot", "Δ Spot", "Call OI", "Put OI", "Δ OI", "PCR", "Max pain", "OI state"].map((h, i) => (
                  <th key={h} className={`border-b border-term-border px-3 py-1.5 font-medium ${i === 0 || i === 8 ? "text-left" : "text-right"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => {
                const td = "num border-b border-term-border/40 px-3 py-1.5 text-right whitespace-nowrap";
                return (
                  <tr key={r.date} className="hover:bg-term-panel/60">
                    <td className="num whitespace-nowrap border-b border-term-border/40 px-3 py-1.5 text-left text-term-dim">{dmy(r.date)} {r.date.slice(0, 4)}</td>
                    <td className={`${td} font-medium`}>{r.spot ? nf(r.spot, 0) : "–"}</td>
                    <td className={`${td} ${(r.dSpot ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                      {r.dSpot != null && r.spot ? `${r.dSpot >= 0 ? "+" : "−"}${nf(Math.abs(r.dSpot), 0)}` : "–"}
                    </td>
                    <td className={td} style={{ color: "#f87171" }}>{crores(r.ceOI)}</td>
                    <td className={td} style={{ color: "#4ade80" }}>{crores(r.peOI)}</td>
                    <td className={`${td} ${(r.dOI ?? 0) >= 0 ? "text-term-text" : "text-amber-400"}`}>
                      {r.dOI != null ? `${r.dOI >= 0 ? "+" : "−"}${oiCr(Math.abs(r.dOI))}` : "–"}
                    </td>
                    <td className={td}>{r.pcr != null ? nf(r.pcr, 2) : "–"}</td>
                    <td className={td}>{r.maxPain != null ? nf(r.maxPain, 0) : "–"}</td>
                    <td className={`border-b border-term-border/40 px-3 py-1.5 text-left font-semibold ${STATE_CLS[r.state ?? ""] ?? "text-term-dim"}`}>
                      {r.state ? r.state.split(" ").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ") : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
