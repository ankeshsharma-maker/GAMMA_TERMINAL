import { useState } from "react";
import { useStore } from "../store";
import { nf, sk } from "../lib/format";
import { getDefaultLots, getDefaultProduct } from "../lib/prefs";
import { isViewer } from "../lib/auth";
import type { WatchQuote } from "../types";

/** Flattrade-style order sheet for a watchlist contract (option / future):
 *  BUY / SELL, lots, NRML / MIS, Market / Limit, and an optional SL / Target
 *  PRICE that's attached to the leg once it fills (the server then squares it
 *  off at market when one is hit). Live orders still go through the LIVE
 *  confirm; paper (and view-only users) fill on paper. */
export function OrderSheet({ w, name, onClose, onChart }: { w: WatchQuote; name: string; onClose: () => void; onChart: () => void }) {
  const orderMode = useStore((s) => s.orderMode);
  const orderFromSheet = useStore((s) => s.orderFromSheet);
  const live = orderMode === "live" && !isViewer();
  const ltp = w.ltp ?? null;

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [lots, setLots] = useState(getDefaultLots());
  const [product, setProduct] = useState<"NRML" | "MIS">(getDefaultProduct() === "MIS" ? "MIS" : "NRML");
  const [type, setType] = useState<"MKT" | "LMT">("MKT");
  const [limit, setLimit] = useState(ltp != null ? String(ltp) : "");
  const [sl, setSl] = useState("");
  const [target, setTarget] = useState("");
  const [trail, setTrail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const buy = side === "BUY";
  const lotSize = w.lotSize || 1;
  const px = type === "LMT" ? parseFloat(limit) || 0 : ltp ?? 0;
  const value = px * lots * lotSize;

  const place = async () => {
    setErr(null);
    const s = sl ? parseFloat(sl) : null;
    const t = target ? parseFloat(target) : null;
    const tr = trail ? parseFloat(trail) : null;
    if (tr != null && !(tr > 0)) return setErr("Trailing SL must be more than 0 points.");
    if (tr != null && px && tr >= px) return setErr(`Trailing SL ${tr} pts is more than the price itself.`);
    // a stop / target on the wrong side of the entry would exit at once
    if (s != null && px && (buy ? s >= px : s <= px)) return setErr(`SL must be ${buy ? "below" : "above"} the price (${nf(px)}).`);
    if (t != null && px && (buy ? t <= px : t >= px)) return setErr(`Target must be ${buy ? "above" : "below"} the price (${nf(px)}).`);
    if (type === "LMT" && !(parseFloat(limit) > 0)) return setErr("Enter a limit price.");
    setBusy(true);
    try {
      await orderFromSheet({
        symbol: w.symbol,
        expiry: w.expiry ?? "",
        strike: w.strike ?? 0,
        optionType: w.kind === "future" ? "FUT" : (w.optionType as "CE" | "PE"),
        side,
        lots,
        orderType: type,
        limitPrice: type === "LMT" ? parseFloat(limit) : null,
        product,
        sl: s,
        target: t,
        trail: tr,
        lotSize,
        ltp,
      });
      onClose();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const seg = (on: boolean, tone = "accent") =>
    `flex-1 rounded border py-1.5 text-[12px] font-semibold ${
      on
        ? tone === "up"
          ? "border-up bg-up text-white"
          : tone === "down"
          ? "border-down bg-down text-white"
          : "border-term-accent bg-term-accent/20 text-term-accent"
        : "border-term-border text-term-dim"
    }`;
  const inp =
    "num w-full rounded border border-term-border bg-term-bg px-2 py-1.5 text-[13px] text-term-text outline-none focus:border-term-accent";

  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl border border-term-border bg-term-panel p-3 shadow-2xl sm:rounded-xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* contract + price */}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-term-text">{name}</div>
            <div className="text-[11px] text-term-dim">
              {w.kind === "future" ? "Future" : `${sk(w.strike)} ${w.optionType}`} · lot {lotSize}
              {live ? (
                <span className="ml-1.5 rounded bg-down px-1 text-[9px] font-bold text-white">LIVE</span>
              ) : (
                <span className="ml-1.5 rounded bg-term-border px-1 text-[9px] font-bold text-term-text">PAPER</span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="num text-[16px] font-semibold text-term-text">{ltp != null ? nf(ltp) : "–"}</div>
            <button
              onClick={onChart}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-term-accent/60 bg-term-accent/15 px-3 py-1.5 text-[13px] font-semibold text-term-accent active:bg-term-accent/30"
            >
              📈 Chart
            </button>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <button onClick={() => setSide("BUY")} className={seg(buy, "up")}>BUY</button>
          <button onClick={() => setSide("SELL")} className={seg(!buy, "down")}>SELL</button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Lots · qty {lots * lotSize}</div>
            <div className="flex items-center gap-1">
              <button onClick={() => setLots((n) => Math.max(1, n - 1))} className="rounded border border-term-border px-3 py-1.5 text-term-text">−</button>
              <span className="num flex-1 text-center text-[14px] font-semibold text-term-text">{lots}</span>
              <button onClick={() => setLots((n) => Math.min(500, n + 1))} className="rounded border border-term-border px-3 py-1.5 text-term-text">+</button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Product</div>
            <div className="flex gap-1">
              <button onClick={() => setProduct("NRML")} className={seg(product === "NRML")}>NRML</button>
              <button onClick={() => setProduct("MIS")} className={seg(product === "MIS")}>MIS</button>
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Order</div>
            <div className="flex gap-1">
              <button onClick={() => setType("MKT")} className={seg(type === "MKT")}>Market</button>
              <button onClick={() => setType("LMT")} className={seg(type === "LMT")}>Limit</button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-term-dim">Limit price</div>
            <input
              id="sheet-limit"
              disabled={type !== "LMT"}
              value={type === "LMT" ? limit : ""}
              onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={type === "LMT" ? "price" : "at market"}
              className={`${inp} disabled:opacity-40`}
            />
          </div>
        </div>

        {/* protection, attached once the order fills */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-down">Stop-loss price</div>
            <input id="sheet-sl" value={sl} onChange={(e) => setSl(e.target.value.replace(/[^\d.]/g, ""))} placeholder={buy ? "below price" : "above price"} className={inp} />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-up">Target price</div>
            <input id="sheet-tgt" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} placeholder={buy ? "above price" : "below price"} className={inp} />
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-400">Trailing SL · points</div>
            <input
              id="sheet-trail"
              value={trail}
              onChange={(e) => setTrail(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="e.g. 10"
              className={inp}
            />
          </div>
          <div className="self-end pb-1 text-[10px] leading-snug text-term-dim">
            {trail && parseFloat(trail) > 0
              ? buy
                ? `Exits if price falls ${trail} pts from its highest since entry.`
                : `Exits if price rises ${trail} pts from its lowest since entry.`
              : "Follows the price: the stop moves up (buy) / down (sell) as it goes your way."}
          </div>
        </div>
        <div className="mt-1 text-[10px] leading-snug text-term-dim">
          Optional. Attached to this leg once it fills; the server exits at market when one is hit (works with the app closed).
          With both an SL and a trailing SL, the tighter one applies.
        </div>

        {err && <div className="mt-2 text-[12px] text-down">{err}</div>}

        <button
          disabled={busy}
          onClick={place}
          className={`mt-3 w-full rounded-lg py-3 text-[14px] font-bold text-white disabled:opacity-50 ${buy ? "bg-up" : "bg-down"}`}
        >
          {busy ? "…" : `${side} ${lots} lot${lots === 1 ? "" : "s"}`}
          {px ? <span className="ml-1.5 text-[12px] font-normal opacity-90">≈ ₹{nf(value, 0)}</span> : null}
          {live && <span className="ml-1.5 text-[11px] font-normal opacity-90">· review next</span>}
        </button>
      </div>
    </div>
  );
}
