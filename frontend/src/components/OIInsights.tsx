import { useEffect, useMemo, useState } from "react";
import { api, type OiWallPt } from "../lib/api";
import { nf, oiCr, oiSigned, sk } from "../lib/format";
import { istTime } from "../lib/istTime";
import type { Chain, ChainRow } from "../types";

/** OI tab -> Insights: (A) where the call / put walls are, how far spot is from them and whether they moved today;
 *  (B) how each strike's OI changed over several windows at once (5m / 15m / 1h / day), so "still being written
 *  now" is told apart from "was written earlier". Built from the chain already on screen + the ΔOI window series. */

const WINDOWS: { key: "m5" | "m15" | "m30" | "h1" | "day"; label: string; min: number }[] = [
  { key: "m5", label: "5m", min: 5 },
  { key: "m15", label: "15m", min: 15 },
  { key: "m30", label: "30m", min: 30 },
  { key: "h1", label: "1h", min: 60 },
  { key: "day", label: "Day", min: 0 },
];
type Win = Record<string, { ceOiChg: number; peOiChg: number }>;
const TOP = 5;

function WallRow({ strike, oi, chg, max, tone }: { strike: number; oi: number; chg: number; max: number; tone: "call" | "put" }) {
  const pct = max > 0 ? Math.min(100, (oi / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[52px_1fr_98px] items-center gap-1.5 py-[3px]">
      <span className="num text-[13px] font-semibold text-term-text">{sk(strike)}</span>
      <div className={`h-2.5 rounded-sm ${tone === "call" ? "bg-down/15" : "bg-up/15"}`}>
        <div className={`h-full rounded-sm ${tone === "call" ? "bg-down/80" : "bg-up/80"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="num text-right text-[12px] text-term-text">
        {oiCr(oi)} <span className={chg > 0 ? (tone === "call" ? "text-down" : "text-up") : chg < 0 ? (tone === "call" ? "text-up" : "text-down") : "text-term-dim"}>{oiSigned(chg)}</span>
      </span>
    </div>
  );
}

export function OIInsights({ chain, symbol, expiry }: { chain: Chain; symbol: string; expiry: string }) {
  const spot = chain.liveSpot?.ltp ?? chain.spot;
  const rows = chain.rows;

  // ---- A: walls ----
  const walls = useMemo(() => {
    const calls = rows.filter((r) => r.strike > spot && r.call.oi > 0).sort((a, b) => b.call.oi - a.call.oi).slice(0, TOP);
    const puts = rows.filter((r) => r.strike < spot && r.put.oi > 0).sort((a, b) => b.put.oi - a.put.oi).slice(0, TOP);
    const max = Math.max(1, ...calls.map((r) => r.call.oi), ...puts.map((r) => r.put.oi));
    return { calls, puts, max };
  }, [rows, spot]);
  const r1 = walls.calls[0];
  const s1 = walls.puts[0];

  // the recorded wall points of today: did the top walls move?
  const [wallPts, setWallPts] = useState<OiWallPt[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.oiWalls(symbol, expiry || undefined).then(
        (d) => alive && setWallPts(d.points),
        () => alive && setWallPts([])
      );
    load();
    const id = window.setInterval(() => !document.hidden && load(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol, expiry]);
  const moved = (k: "cw" | "pw"): string => {
    const pts = wallPts ?? [];
    if (pts.length < 2) return "";
    const last = pts[pts.length - 1];
    let i = pts.length - 1;
    while (i > 0 && pts[i - 1][k] === last[k]) i--;
    if (i === 0) return `${k === "cw" ? "call" : "put"} wall ${sk(last[k])} unchanged today`;
    const from = pts[i - 1][k];
    const d = last[k] - from;
    return `${k === "cw" ? "call" : "put"} wall moved ${d > 0 ? "up" : "down"} ${Math.abs(d)} pts to ${sk(last[k])} at ${istTime(pts[i].t)}`;
  };

  // ---- B: ΔOI over windows ----
  const [side, setSide] = useState<"call" | "put">("call");
  const [wins, setWins] = useState<Record<string, { data: Win; cov: number } | undefined>>({});
  useEffect(() => {
    let alive = true;
    const load = () =>
      WINDOWS.filter((w) => w.min > 0).forEach((w) =>
        api.oiChange(symbol, expiry || undefined, w.min).then(
          (d) => {
            if (!alive) return;
            const m: Win = {};
            for (const [k, v] of Object.entries(d.strikes)) m[k] = { ceOiChg: v.ceOiChg, peOiChg: v.peOiChg };
            setWins((cur) => ({ ...cur, [w.key]: { data: m, cov: d.coverageMin } }));
          },
          () => {}
        )
      );
    setWins({});
    load();
    const id = window.setInterval(() => !document.hidden && load(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [symbol, expiry]);

  const tableRows = useMemo<ChainRow[]>(() => {
    let atm = rows.findIndex((r) => r.strike === chain.atmStrike);
    if (atm < 0) atm = Math.floor(rows.length / 2);
    const keep = new Set<number>();
    for (let i = Math.max(0, atm - 4); i <= Math.min(rows.length - 1, atm + 4); i++) keep.add(rows[i].strike);
    if (r1) keep.add(r1.strike);
    if (s1) keep.add(s1.strike);
    return rows.filter((r) => keep.has(r.strike));
  }, [rows, chain.atmStrike, r1, s1]);

  const val = (r: ChainRow, w: (typeof WINDOWS)[number]): number | null => {
    if (w.key === "day") return side === "call" ? r.call.oiChg : r.put.oiChg;
    const e = wins[w.key];
    if (!e || e.cov < 1) return null; // no history that far back yet
    const v = e.data[String(Math.round(r.strike))];
    return v ? (side === "call" ? v.ceOiChg : v.peOiChg) : 0;
  };
  const colMax = WINDOWS.map((w) => Math.max(1, ...tableRows.map((r) => Math.abs(val(r, w) ?? 0))));
  // adding OI on the call side = resistance (red); on the put side = support (green)
  const addCol = side === "call" ? "#dc2626" : "#16a34a";
  const cutCol = side === "call" ? "#16a34a" : "#dc2626";
  const cell = (v: number | null, mx: number) => {
    if (v == null) return { bg: undefined, txt: "–", weight: 400 };
    const a = Math.min(1, Math.abs(v) / mx);
    const pct = v === 0 ? 0 : Math.round(8 + a * 60);
    return {
      bg: v === 0 ? undefined : `color-mix(in srgb, ${v > 0 ? addCol : cutCol} ${pct}%, transparent)`,
      txt: v === 0 ? "0" : `${v > 0 ? "+" : "−"}${nf(Math.abs(v) >= 1000 ? Math.abs(v) / 1000 : Math.abs(v), Math.abs(v) >= 1000 ? 1 : 0)}${Math.abs(v) >= 1000 ? "K" : ""}`,
      weight: a > 0.6 ? 600 : 400,
    };
  };
  // a strike being added in every window at once = still being written now
  const building = useMemo(() => {
    let best: { k: number; s: number } | null = null;
    for (const r of tableRows) {
      const vs = WINDOWS.map((w) => val(r, w));
      if (vs.some((v) => v == null) || !vs.every((v) => (v as number) > 0)) continue;
      const s = vs[3] as number; // the 1h column
      if (!best || s > best.s) best = { k: r.strike, s };
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableRows, wins, side]);
  const haveHist = WINDOWS.filter((w) => w.min > 0).some((w) => (wins[w.key]?.cov ?? 0) >= 1);

  const card = "rounded-xl border border-term-border bg-term-panel p-3";
  const distR = r1 ? Math.round(r1.strike - spot) : null;
  const distS = s1 ? Math.round(spot - s1.strike) : null;
  const G = "border-b border-r border-term-dim/50";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 overflow-y-auto p-2 sm:grid sm:max-w-none sm:grid-cols-2 sm:items-start md:p-3">
      {/* A ---------------------------------------------------- */}
      <div className={card}>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-term-text">Walls at a glance</span>
          <span className="num text-[12px] text-term-dim">spot {nf(spot, 1)}</span>
        </div>
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-down">Resistance · most call OI above spot</div>
        {walls.calls.length ? (
          walls.calls.map((r) => <WallRow key={r.strike} strike={r.strike} oi={r.call.oi} chg={r.call.oiChg} max={walls.max} tone="call" />)
        ) : (
          <div className="py-1 text-[12px] text-term-dim">no call OI above spot</div>
        )}
        <div className="my-2 flex justify-center">
          <span className="rounded-full border border-term-dim/60 px-3 py-0.5 text-[12px] text-term-dim">
            ▶ spot is {distR != null ? `${distR} pts below R1` : "—"} · {distS != null ? `${distS} pts above S1` : "—"}
          </span>
        </div>
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-up">Support · most put OI below spot</div>
        {walls.puts.length ? (
          walls.puts.map((r) => <WallRow key={r.strike} strike={r.strike} oi={r.put.oi} chg={r.put.oiChg} max={walls.max} tone="put" />)
        ) : (
          <div className="py-1 text-[12px] text-term-dim">no put OI below spot</div>
        )}
        <div className="mt-2 border-t border-term-border pt-2 text-[12px] leading-snug text-term-dim">
          {r1 && s1 ? <>Range {sk(s1.strike)} – {sk(r1.strike)} · </> : null}
          max pain {sk(chain.maxPain)} · PCR {chain.pcr != null ? nf(chain.pcr, 2) : "–"}
          {wallPts && wallPts.length >= 2 ? (
            <>
              <br />
              {moved("cw")} · {moved("pw")}
            </>
          ) : null}
        </div>
      </div>

      {/* B ---------------------------------------------------- */}
      <div className={card}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-term-text">ΔOI over several windows</span>
          <div className="seg">
            <button className={side === "call" ? "on" : ""} onClick={() => setSide("call")}>
              Calls
            </button>
            <button className={side === "put" ? "on" : ""} onClick={() => setSide("put")}>
              Puts
            </button>
          </div>
        </div>
        <table className="w-full border-separate border-spacing-0 border-l border-t border-term-dim/50 text-[12px] tabular-nums">
          <thead>
            <tr className="text-term-dim">
              <th className={`${G} px-1.5 py-1 text-left font-medium`}>Strike</th>
              {WINDOWS.map((w) => (
                <th key={w.key} className={`${G} px-1.5 py-1 text-right font-medium`}>
                  {w.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((r) => {
              const isR = r1 && r.strike === r1.strike;
              const isS = s1 && r.strike === s1.strike;
              const atm = r.strike === chain.atmStrike;
              return (
                <tr key={r.strike} className={atm ? "outline outline-1 -outline-offset-1 outline-term-accent" : ""}>
                  <td className={`${G} whitespace-nowrap px-1.5 py-1 font-semibold ${isR ? "text-down" : isS ? "text-up" : "text-term-text"}`}>
                    {sk(r.strike)}
                    {isR && <span className="ml-1 rounded bg-down/15 px-1 text-[9px]">R</span>}
                    {isS && <span className="ml-1 rounded bg-up/15 px-1 text-[9px]">S</span>}
                  </td>
                  {WINDOWS.map((w, i) => {
                    const c = cell(val(r, w), colMax[i]);
                    return (
                      <td key={w.key} className={`${G} px-1.5 py-1 text-right text-term-text`} style={{ background: c.bg, fontWeight: c.weight }}>
                        {c.txt}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-2 text-[12px] leading-snug text-term-dim">
          {side === "call" ? (
            <>
              <span className="text-down">red</span> = call OI added (resistance building), <span className="text-up">green</span> = cut.{" "}
            </>
          ) : (
            <>
              <span className="text-up">green</span> = put OI added (support building), <span className="text-down">red</span> = cut.{" "}
            </>
          )}
          {building ? (
            <span className="text-term-text">
              {sk(building.k)} is being added in every window, so it is still being written now, not just earlier in the day.
            </span>
          ) : haveHist ? (
            "No strike here is being added in every window."
          ) : (
            "The short windows fill in as the app collects a few minutes of live history."
          )}
        </div>
      </div>
    </div>
  );
}
