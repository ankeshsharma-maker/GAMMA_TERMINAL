import { useEffect, useMemo, useState } from "react";
import type { OiType, VolRow } from "../lib/api";
import { nf } from "../lib/format";
import { Chips, MinTraded, ScanHeader, ScanTable, useStockScan, type Metric, type Universe } from "./StockScanTable";

type Mode = "volbuild" | "deliv" | "dma" | "wk" | "mo" | "setup" | "oi";
type DmaPick = "above3" | "below3" | "above200" | "below200";
type Setup = "nr7" | "inside" | "both";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${nf(v, Math.abs(v) >= 10 ? 1 : 2)}%`;
const pctCls = (v: number | null | undefined) => (v == null ? "text-term-dim" : v >= 0 ? "text-up" : "text-down");
const dim = <span className="text-term-dim">–</span>;
/** "20260925" -> "25 Sep" */
const ymd = (s?: string | null) =>
  s ? new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";

const OI_LABEL: Record<OiType, { label: string; up: boolean; title: string }> = {
  LONG_BUILDUP: { label: "Long build-up", up: true, title: "price up, futures OI up: new buying" },
  SHORT_BUILDUP: { label: "Short build-up", up: false, title: "price down, futures OI up: new selling" },
  SHORT_COVERING: { label: "Short covering", up: true, title: "price up, futures OI down: shorts buying back" },
  LONG_UNWINDING: { label: "Long unwinding", up: false, title: "price down, futures OI down: longs selling out" },
};

/** Positional scans -- signals that build over days, not just today: volume build-up, delivery %,
 *  the 20 / 50 / 200-day averages, weekly / monthly breakouts, NR7 / inside days, and futures OI
 *  build-up (F&O stocks). Same grid as Volume / Movers, today's live price against the history. */
export function PositionalScan() {
  const [universe, setUniverse] = useState<Universe>("fo");
  const [mode, setMode] = useState<Mode>("volbuild");
  const [minCr, setMinCr] = useState(0);
  const [volMin, setVolMin] = useState(1.5);
  const [delivMin, setDelivMin] = useState(60);
  const [dmaPick, setDmaPick] = useState<DmaPick>("above3");
  const [side, setSide] = useState<"UP" | "DOWN">("UP");
  const [setup, setSetup] = useState<Setup>("nr7");
  const [oiType, setOiType] = useState<OiType>("LONG_BUILDUP");
  const [oiWin, setOiWin] = useState<1 | 5>(5);
  const [oiMin, setOiMin] = useState(5);
  const { data, err } = useStockScan(universe, true);
  useEffect(() => setMinCr(universe !== "fo" ? 5 : 0), [universe]);

  const d = (r: VolRow, n: string) => r.dma?.[n];
  const oiChg = (r: VolRow) => (oiWin === 1 ? r.oiChg1 : r.oiChg5);
  const pxChg = (r: VolRow) => (oiWin === 1 ? r.pxChg1 : r.pxChg5);
  const oiTyp = (r: VolRow) => (oiWin === 1 ? r.oiType1 : r.oiType5);

  const rows = useMemo(() => {
    const r = (data?.rows ?? []).filter((x) => x.value >= minCr * 1e7);
    switch (mode) {
      case "volbuild":
        return r.filter((x) => (x.volBuild ?? 0) >= volMin);
      case "deliv":
        return r.filter((x) => (x.deliv ?? 0) >= delivMin);
      case "dma":
        return r.filter((x) => {
          const a = [d(x, "20"), d(x, "50"), d(x, "200")];
          if (dmaPick === "above3") return a.every((v) => v != null && v > 0);
          if (dmaPick === "below3") return a.every((v) => v != null && v < 0);
          const v = d(x, "200");
          return v != null && (dmaPick === "above200" ? v > 0 : v < 0);
        });
      case "wk":
        return r.filter((x) => x.wk === side);
      case "mo":
        return r.filter((x) => x.mo === side);
      case "setup":
        return r.filter((x) => (setup === "nr7" ? x.nr7 : setup === "inside" ? x.inside : x.nr7 && x.inside));
      case "oi":
        return r.filter((x) => oiTyp(x) === oiType && Math.abs(oiChg(x) ?? 0) >= oiMin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, minCr, volMin, delivMin, dmaPick, side, setup, oiType, oiWin, oiMin]);

  const metric: Metric = (() => {
    switch (mode) {
      case "volbuild":
        return {
          label: "5d vol",
          cell: (r) =>
            r.volBuild == null ? dim : (
              <span className={r.volBuild >= 2 ? "font-bold text-amber-400" : "text-term-accent"}>{nf(r.volBuild, 1)}x</span>
            ),
          sort: (r) => r.volBuild ?? null,
        };
      case "deliv":
        return {
          label: "Deliv",
          cell: (r) => (r.deliv == null ? dim : <span className={r.deliv >= 70 ? "font-bold text-amber-400" : "text-term-text"}>{nf(r.deliv, 0)}%</span>),
          sort: (r) => r.deliv ?? null,
        };
      case "dma": {
        const n = dmaPick === "above3" || dmaPick === "below3" ? "20" : "200";
        return {
          label: `vs ${n}D`,
          cell: (r) => (d(r, n) == null ? dim : <span className={pctCls(d(r, n))}>{pct(d(r, n)!)}</span>),
          sort: (r) => d(r, n) ?? null,
        };
      }
      case "wk":
      case "mo":
        return {
          label: `vs ${mode === "wk" ? "wk" : "mo"} ${side === "UP" ? "H" : "L"}`,
          cell: (r) => {
            const v = mode === "wk" ? r.wkPct : r.moPct;
            return v == null ? dim : <span className={pctCls(v)}>{pct(v)}</span>;
          },
          sort: (r) => (mode === "wk" ? r.wkPct : r.moPct) ?? null,
        };
      case "setup":
        return {
          label: "Range",
          cell: (r) => (r.rangePct == null ? dim : <span className="text-term-text">{nf(r.rangePct, 1)}%</span>),
          sort: (r) => r.rangePct ?? null,
        };
      case "oi":
        return {
          label: "OI chg",
          cell: (r) => (oiChg(r) == null ? dim : <span className={pctCls(oiChg(r))}>{pct(oiChg(r)!)}</span>),
          sort: (r) => oiChg(r) ?? null,
        };
    }
  })();

  // a small second-line note under the symbol, per mode
  const tag = (r: VolRow) => {
    if (mode === "deliv" && r.delivX != null)
      return <span className={`shrink-0 text-[9px] font-bold ${r.delivX >= 1.3 ? "text-amber-400" : "text-term-dim"}`}>{nf(r.delivX, 1)}x avg</span>;
    if (mode === "volbuild" && r.volUp != null)
      return <span className="shrink-0 text-[9px] font-bold text-term-dim">{r.volUp}/5 days up{r.ret5 != null ? ` · ${pct(r.ret5)}` : ""}</span>;
    if (mode === "oi" && pxChg(r) != null)
      return <span className={`shrink-0 text-[9px] font-bold ${pctCls(pxChg(r))}`}>price {pct(pxChg(r)!)}</span>;
    if (mode === "setup" && r.nr7 && r.inside) return <span className="shrink-0 text-[9px] font-bold text-amber-400">NR7 + inside</span>;
    return null;
  };

  const sortDir: 1 | -1 =
    (mode === "dma" && (dmaPick === "below3" || dmaPick === "below200")) ||
    ((mode === "wk" || mode === "mo") && side === "DOWN") ||
    mode === "setup" ||
    (mode === "oi" && (oiType === "SHORT_COVERING" || oiType === "LONG_UNWINDING"))
      ? 1
      : -1;

  const nse = data?.nse;
  const needFo = mode === "oi" && universe === "cash";
  const empty = !data || data.rows.length === 0
    ? "No quotes yet — they arrive within a minute."
    : needFo
    ? "Futures OI is for F&O stocks — switch to F&O or All NSE."
    : (mode === "deliv" && !nse?.delivDays) || (mode === "oi" && !nse?.foDays)
    ? "Fetching NSE's end-of-day files — a minute or two."
    : "Nothing matches right now.";
  const base = data?.baseline;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-term-bg">
      <div className="space-y-2 border-b border-term-border bg-term-panel2 px-3 py-2">
        <ScanHeader title="Positional" universe={universe} setUniverse={setUniverse} data={data} />
        <Chips<Mode>
          items={[
            ["volbuild", "Volume build-up"],
            ["deliv", "Delivery %"],
            ["dma", "Moving averages"],
            ["wk", "Weekly breakout"],
            ["mo", "Monthly breakout"],
            ["setup", "NR7 / Inside day"],
            ["oi", "F&O OI build-up"],
          ]}
          value={mode}
          onChange={setMode}
        />
        <MinTraded value={minCr} onChange={setMinCr} />
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
          {mode === "volbuild" && (
            <>
              <span>5-day volume at least</span>
              <Chips<number> items={[[1.3, "1.3x"], [1.5, "1.5x"], [2, "2x"], [3, "3x"]]} value={volMin} onChange={setVolMin} />
            </>
          )}
          {mode === "deliv" && (
            <>
              <span>Delivery at least</span>
              <Chips<number> items={[[40, "40%"], [50, "50%"], [60, "60%"], [70, "70%"]]} value={delivMin} onChange={setDelivMin} />
            </>
          )}
          {mode === "dma" && (
            <Chips<DmaPick>
              items={[
                ["above3", "Above 20 / 50 / 200"],
                ["below3", "Below all three"],
                ["above200", "Above 200D"],
                ["below200", "Below 200D"],
              ]}
              value={dmaPick}
              onChange={setDmaPick}
            />
          )}
          {(mode === "wk" || mode === "mo") && (
            <Chips<"UP" | "DOWN">
              items={[
                ["UP", `Above last ${mode === "wk" ? "week's" : "month's"} high`],
                ["DOWN", `Below last ${mode === "wk" ? "week's" : "month's"} low`],
              ]}
              value={side}
              onChange={setSide}
            />
          )}
          {mode === "setup" && (
            <Chips<Setup> items={[["nr7", "NR7"], ["inside", "Inside day"], ["both", "Both"]]} value={setup} onChange={setSetup} />
          )}
          {mode === "oi" && (
            <>
              <Chips<OiType>
                items={(Object.keys(OI_LABEL) as OiType[]).map((k) => [k, OI_LABEL[k].label] as [OiType, string])}
                value={oiType}
                onChange={setOiType}
              />
              <Chips<1 | 5> items={[[1, "1 day"], [5, "5 days"]]} value={oiWin} onChange={setOiWin} />
              <span>OI change at least</span>
              <Chips<number> items={[[3, "3%"], [5, "5%"], [10, "10%"], [20, "20%"]]} value={oiMin} onChange={setOiMin} />
            </>
          )}
        </div>
        {base && base.ready < base.total && (
          <div className="text-[11px] text-amber-400">
            Loading each stock's daily history: {base.ready} / {base.total} ready
            {universe !== "fo" ? " — the first time for all NSE takes about 45 min" : ""}.
          </div>
        )}
      </div>

      {err ? (
        <div className="p-4 text-center text-[12px] text-down">{err}</div>
      ) : !data ? (
        <div className="p-6 text-center text-[12px] text-term-dim">Loading…</div>
      ) : (
        <ScanTable
          rows={needFo ? [] : rows}
          metric={metric}
          sort={{ key: "metric", dir: sortDir }}
          tag={tag}
          empty={empty}
        />
      )}
      <div className="space-y-1 px-3 py-3 text-[10px] leading-snug text-term-dim">
        <p>
          <b className="text-term-text">Volume build-up</b>: the last 5 sessions' average volume vs the 20-day average (today
          counts once the market has closed); under the symbol, how many of those 5 days beat the average and the 5-day move.
        </p>
        <p>
          <b className="text-term-text">Delivery %</b>: share of the traded quantity taken for delivery, from NSE's file
          {nse?.delivLast ? ` of ${ymd(nse.delivLast)}` : ""} — high delivery = investors taking the shares home, not just day
          trades; "x avg" = vs that stock's own last ~10 sessions.
        </p>
        <p>
          <b className="text-term-text">Moving averages</b>: today's price vs the 20 / 50 / 200-day average close.{" "}
          <b className="text-term-text">Weekly / monthly breakout</b>: price past the last completed week's / month's high or
          low. <b className="text-term-text">NR7</b>: the last finished session had the narrowest range of the last 7;{" "}
          <b className="text-term-text">inside day</b>: its whole range sat inside the day before — both often come before a
          bigger move.
        </p>
        <p>
          <b className="text-term-text">F&amp;O OI build-up</b>: stock-futures open interest (all expiries together, so month-end
          rollover doesn't read as unwinding) and the price, over 1 or 5 sessions to NSE's file
          {nse?.foLast ? ` of ${ymd(nse.foLast)}` : ""}. Long build-up = price ↑ OI ↑, short build-up = price ↓ OI ↑, short
          covering = price ↑ OI ↓, long unwinding = price ↓ OI ↓; a price change under 0.25% isn't classed. Bonus / split days
          are adjusted using NSE's own adjusted previous close.
        </p>
        <p>NSE publishes both files around 6–7 PM for the day. Tap a header to sort, a stock for its details (Chart button inside); ☆ adds it to the watchlist.</p>
      </div>
    </div>
  );
}
