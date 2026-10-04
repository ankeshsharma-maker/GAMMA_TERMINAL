import { useEffect, useRef, useState } from "react";
import { api, type ScanBt, type ScanBtHorizon } from "../lib/api";
import { nf } from "../lib/format";
import { Chips } from "./StockScanTable";

type Universe = "fo" | "cash" | "all";
const UNI: Record<Universe, string> = { fo: "F&O stocks", cash: "the 500 most-traded other NSE stocks", all: "F&O + the 500 most-traded other stocks" };
const sgn = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${nf(v, d)}%`;
const toneCls = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-term-text");

/** How reliable is an edge? `tc` is the t-score on DAILY averages (a market-wide day with 80 stocks counts once),
 *  `t` the plain one. Real = both big and the same sign; otherwise it is probably a few big market days. */
function reliability(h: ScanBtHorizon): "real" | "market-days" | "none" | "few" {
  if (!h.n || h.n < 30) return "few";
  const edge = h.edge ?? 0;
  if (h.tc != null && Math.abs(h.tc) >= 2 && Math.sign(h.tc) === Math.sign(edge)) return "real";
  if (h.t != null && Math.abs(h.t) >= 2) return "market-days";
  return "none";
}

/** A "Backtest this signal" button for a Scan tab: takes the tab's own signal + filters, runs them over the last 5 years of
 *  daily candles on the server and shows whether the stock then moved the way the signal says -- against the average stock. */
export function ScanBacktest({
  scan,
  params,
  universe,
  minCr,
  label,
  directionNote,
  unsupported,
}: {
  scan: string;
  params: Record<string, string | number>;
  universe: Universe;
  minCr: number;
  /** the signal in plain words, e.g. "price above last week's high" */
  label: string;
  /** shown for signals with no built-in direction (volume build-up: follows the last 5 days' move) */
  directionNote?: string;
  /** a reason this tab's signal can't be backtested (no history of it), shown instead of the button */
  unsupported?: string;
}) {
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<ScanBt | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // "tab" = the signal the tab is showing; "combo" = the preset: a breakout + heavy volume (+ the market's trend)
  const [view, setView] = useState<"tab" | "combo">("tab");
  const [brk, setBrk] = useState<"wk" | "mo" | "w52">("w52");
  const [vol, setVol] = useState(2);
  const [mkt, setMkt] = useState<"all" | "up" | "down">("all");
  const seq = useRef(0);
  const combo = view === "combo";
  const useScan = combo ? "breakvol" : scan;
  const useParams = combo ? { brk, min: vol } : params;
  const BRK = { wk: "last week's high", mo: "last month's high", w52: "a new 52-week high" } as const;
  const useLabel = combo
    ? `a close past ${BRK[brk]}${vol ? ` on volume ≥ ${vol}x its 20-day average` : ""}`
    : label;
  const key = JSON.stringify([useScan, useParams, universe, minCr, mkt]);

  useEffect(() => {
    if (!open || unsupported) return;
    const my = ++seq.current;
    setBusy(true);
    setErr("");
    api
      .scanBacktest({ scan: useScan, params: useParams, universe, minValueCr: minCr, market: mkt })
      .then((r) => {
        if (my !== seq.current) return;
        if (r.error) setErr(r.error);
        else setRes(r);
      })
      .catch((e) => my === seq.current && setErr(String(e?.message || e)))
      .finally(() => my === seq.current && setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  if (unsupported)
    return (
      <div className="mx-1 mt-2 rounded-md border border-term-border px-3 py-2 text-[11px] text-term-dim">
        <b className="text-term-text">Backtest:</b> {unsupported}
      </div>
    );

  // headline horizon: the most convincing RELIABLE one (largest date-clustered t), else 5 days
  const hs = res?.horizons ?? [];
  const reliable = hs.filter((h) => reliability(h) === "real");
  const h5 =
    reliable.length > 0
      ? reliable.reduce((a, b) => (Math.abs(b.tc ?? 0) > Math.abs(a.tc ?? 0) ? b : a))
      : hs.find((h) => h.h === 5);
  const directional = h5?.directional !== false;
  const rel = h5 ? reliability(h5) : "few";

  return (
    <div className="mx-1 mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="chipbtn text-[12px] font-semibold"
        title="Did stocks move the way this signal says, after it appeared?"
      >
        {open ? "▾" : "▸"} Backtest this signal
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-term-border bg-term-panel px-3 py-2 text-[12px]">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
            <span>Test</span>
            <Chips<"tab" | "combo">
              items={[["tab", "This tab's signal"], ["combo", "Preset: breakout + volume + market"]]}
              value={view}
              onChange={(v) => {
                setView(v);
                if (v === "combo") setMkt("up"); // the preset is "...and the market is rising"
              }}
            />
          </div>
          {combo && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
              <span>Breakout</span>
              <Chips<"wk" | "mo" | "w52"> items={[["wk", "Week high"], ["mo", "Month high"], ["w52", "52-week high"]]} value={brk} onChange={setBrk} />
              <span>Volume</span>
              <Chips<number> items={[[0, "Any"], [1.5, "1.5x"], [2, "2x"], [3, "3x"]]} value={vol} onChange={setVol} />
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-term-dim">
            <span>Market (NIFTY)</span>
            <Chips<"all" | "up" | "down"> items={[["all", "Any"], ["up", "Up-trend"], ["down", "Down-trend"]]} value={mkt} onChange={setMkt} />
            {mkt !== "all" && <span className="text-[10px]">up-trend = NIFTY above its 50-day average, which is above its 200-day · tested from mid-2022</span>}
          </div>
          <div className="text-term-dim">
            Testing: <b className="text-term-text">{useLabel}</b>{mkt !== "all" ? <> · only on days NIFTY was in {mkt === "up" ? "an" : "a"} <b className="text-term-text">{mkt === "up" ? "up" : "down"}-trend</b></> : null} · {UNI[universe]}
            {minCr ? ` · trading ≥ ₹${minCr} Cr/day` : ""} · last 5 years of daily candles. Each time a stock <i>entered</i> this scan at the close,
            buy at the next day's open, check after 1–20 days.
            {directionNote && !combo ? <> {directionNote}</> : null}
          </div>
          {busy && <div className="mt-2 text-term-dim">Running over 5 years of history… (about 5 seconds)</div>}
          {err && <div className="mt-2 text-down">{err}</div>}
          {res && !busy && !err && h5 && (
            <>
              <div
                className={`mt-2 rounded border px-2 py-1.5 ${
                  rel === "real"
                    ? (h5.edge ?? 0) > 0
                      ? "border-up/60 bg-up/10"
                      : "border-down/60 bg-down/10"
                    : rel === "market-days"
                    ? "border-amber-400/60 bg-amber-400/10"
                    : "border-term-border"
                }`}
              >
                <div className="font-semibold text-term-text">
                  {rel === "few"
                    ? "Too few signals to say anything."
                    : rel === "real"
                    ? (h5.edge ?? 0) > 0
                      ? "It worked: better than the average stock."
                      : "It did worse than the average stock."
                    : rel === "market-days"
                    ? "Looks like an edge, but don't trust it."
                    : "No clear edge: about the same as any stock."}
                </div>
                <div className="mt-0.5 text-term-dim">
                  {directional ? (
                    <>
                      After {h5.h} days the stock moved <b className={toneCls(h5.avg ?? 0)}>{sgn(h5.avg ?? 0)}</b> on average in the signal's direction
                      (costs taken off), and went the right way <b className="text-term-text">{nf(h5.hit ?? 0, 0)}%</b> of the time. An average stock in the
                      same period: <b className="text-term-text">{sgn(h5.baseAvg ?? 0)}</b>, right way {nf(h5.baseHit ?? 0, 0)}%. Difference:{" "}
                      <b className={toneCls(h5.edge ?? 0)}>{sgn(h5.edge ?? 0)}</b>.
                    </>
                  ) : (
                    <>
                      This signal has no direction, so I measured the <i>size</i> of the move: after {h5.h} days stocks moved{" "}
                      <b className="text-term-text">{nf(h5.avg ?? 0)}%</b> either way on average; an average stock moved{" "}
                      <b className="text-term-text">{nf(h5.baseAvg ?? 0)}%</b> — {(h5.edge ?? 0) > 0 ? "bigger" : "smaller"} by {nf(Math.abs(h5.edge ?? 0))}%.
                    </>
                  )}
                  {rel === "market-days" && (
                    <> The plain numbers look strong, but they come from a few market-wide days when many stocks moved together — counted once per day, the edge disappears.</>
                  )}
                </div>
              </div>

              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[420px] text-right text-[11px]">
                  <thead className="text-term-dim">
                    <tr className="border-b border-term-border">
                      <th className="py-1 text-left font-semibold">After</th>
                      <th className="font-semibold">Signals</th>
                      <th className="font-semibold">{directional ? "Avg result" : "Avg move"}</th>
                      <th className="font-semibold">{directional ? "Right way" : "Ended up"}</th>
                      <th className="font-semibold">Avg stock</th>
                      <th className="font-semibold">Edge</th>
                      <th className="font-semibold">Reliable?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.horizons.map((h) => {
                      const r = reliability(h);
                      return (
                        <tr key={h.h} className="border-b border-term-border/50 text-term-text">
                          <td className="py-1 text-left">{h.h} day{h.h > 1 ? "s" : ""}</td>
                          <td>{h.n ? h.n.toLocaleString("en-IN") : "–"}</td>
                          <td className={h.n && directional ? toneCls(h.avg ?? 0) : ""}>{h.n ? (directional ? sgn(h.avg ?? 0) : `${nf(h.avg ?? 0)}%`) : "–"}</td>
                          <td>{h.n ? `${nf(h.hit ?? 0, 0)}%` : "–"}</td>
                          <td className="text-term-dim">{h.n ? (directional ? sgn(h.baseAvg ?? 0) : `${nf(h.baseAvg ?? 0)}%`) : "–"}</td>
                          <td className={`font-bold ${h.n ? toneCls(h.edge ?? 0) : ""}`}>{h.n ? sgn(h.edge ?? 0) : "–"}</td>
                          <td className={r === "real" ? "font-bold text-term-accent" : r === "market-days" ? "text-amber-400" : "text-term-dim"}>
                            {r === "real" ? "✓ yes" : r === "market-days" ? "~ market days" : r === "few" ? "few" : "no"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {h5.byYear && Object.keys(h5.byYear).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-term-dim">
                  <b className="text-term-text">Edge after {h5.h} days, by year:</b>
                  {Object.entries(h5.byYear).map(([y, v]) => (
                    <span key={y} className="whitespace-nowrap">
                      {y} <b className={toneCls(v.edge)}>{sgn(v.edge)}</b> <span className="text-[10px]">({v.n})</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 text-[10px] leading-snug text-term-dim">
                {res.fires.toLocaleString("en-IN")} times a stock entered this scan ({res.stocks} stocks, {res.from} to {res.asOf}). <b>Edge</b> = the result minus what an
                average stock in the same list did over the same days, so a rising market doesn't flatter a bullish signal. <b>Reliable ✓</b> = the edge still stands when
                a day with many stocks counts once. Caveats: the stock lists are today's (stocks that did well tend to be in them), cash stocks can't be sold short
                overnight, and past results don't promise the future.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
