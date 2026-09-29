import { useEffect, useState } from "react";
import { api, type SmcAlertCfg } from "../lib/api";

/** Settings for the server-side Smart Money Concepts alerts (backend smc_alerts.py) + a replay of
 *  what they would have said over the last few sessions, so the alerts can be judged before
 *  they're switched on. Opened from the chart's ◈ SMC menu. */
const KIND_INFO: { key: keyof SmcAlertCfg["kinds"]; name: string; hint: string }[] = [
  { key: "aplus", name: "★ A+ setup", hint: "Sweep → CHoCH the other way → first pullback into the order block it left (discount for a long, premium for a short). Rare." },
  { key: "sweep", name: "Liquidity sweep", hint: "A wick through a swing high / low that closes back inside — stops taken, often a turn." },
  { key: "choch", name: "CHoCH (swing)", hint: "First close through a big swing against the trend — a possible trend change." },
  { key: "ob", name: "Order block, first test", hint: "Price back in an order block for the first time, without closing through it." },
];
const SYMS = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
const istTime = (t: number) =>
  new Date(t * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function SmcAlertsPanel({ onClose, symbol }: { onClose: () => void; symbol: string }) {
  const [cfg, setCfg] = useState<SmcAlertCfg | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rSym, setRSym] = useState(symbol || "NIFTY");
  const [replay, setReplay] = useState<{ time: number; kind: string; dir: string; message: string }[] | null>(null);
  const [rBusy, setRBusy] = useState(false);

  useEffect(() => {
    api.smcAlerts().then(setCfg, (e) => setErr(String(e?.message || e)));
  }, []);
  const tf = cfg?.tf ?? 300;
  useEffect(() => {
    let alive = true;
    setRBusy(true);
    setReplay(null);
    api
      .smcAlertsReplay(rSym, tf, 3)
      .then((d) => alive && setReplay(d.events.slice().reverse()), () => alive && setReplay([]))
      .finally(() => alive && setRBusy(false));
    return () => {
      alive = false;
    };
  }, [rSym, tf]);

  const save = async (patch: Partial<SmcAlertCfg>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch, kinds: { ...cfg.kinds, ...(patch.kinds || {}) } };
    setCfg(next);
    try {
      setCfg(await api.smcAlertsSave(next));
      setSaved("Saved");
      setTimeout(() => setSaved(null), 1500);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };
  const shown = (replay || []).filter((e) => !cfg || cfg.kinds[e.kind as keyof SmcAlertCfg["kinds"]]);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-term-border bg-term-panel p-3 shadow-2xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[14px] font-semibold text-term-text">◈ SMC alerts</div>
            <div className="text-[11px] text-term-dim">
              Checked on the server every minute on closed candles — to the app bell and Telegram, app open or not.
            </div>
          </div>
          <button onClick={onClose} className="px-1 text-term-dim hover:text-term-text" aria-label="Close">
            ✕
          </button>
        </div>
        {err && <div className="mt-2 text-[12px] text-down">{err}</div>}
        {!cfg ? (
          <div className="py-6 text-center text-[12px] text-term-dim">Loading…</div>
        ) : (
          <>
            <button
              onClick={() => save({ enabled: !cfg.enabled })}
              className={`mt-3 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${
                cfg.enabled ? "border-up/60 bg-up/10" : "border-term-border"
              }`}
            >
              <span className="text-[13px] font-semibold text-term-text">{cfg.enabled ? "Alerts ON" : "Alerts OFF"}</span>
              <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${cfg.enabled ? "bg-up text-white" : "bg-term-border text-term-dim"}`}>
                {cfg.enabled ? "ON" : "OFF"}
              </span>
            </button>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wide text-term-dim">Symbols</div>
                <div className="flex flex-wrap gap-1">
                  {SYMS.map((s) => {
                    const on = cfg.symbols.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() =>
                          save({ symbols: on ? cfg.symbols.filter((x) => x !== s) : [...cfg.symbols, s].slice(0, 6) })
                        }
                        className={`chipbtn text-[11px] ${on ? "on" : ""}`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wide text-term-dim">Timeframe</div>
                <div className="seg text-[11px]">
                  {[
                    [300, "5 min"],
                    [900, "15 min"],
                  ].map(([v, l]) => (
                    <button key={v} onClick={() => save({ tf: v as number })} className={cfg.tf === v ? "on" : ""}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-3 text-[9.5px] font-semibold uppercase tracking-wide text-term-dim">Alert me on</div>
            <div className="mt-1 flex flex-col gap-1">
              {KIND_INFO.map((k) => (
                <button
                  key={k.key}
                  onClick={() => save({ kinds: { ...cfg.kinds, [k.key]: !cfg.kinds[k.key] } })}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left ${
                    cfg.kinds[k.key] ? "border-violet-500/50 bg-violet-500/10" : "border-term-border"
                  }`}
                >
                  <span className={`mt-0.5 text-[12px] ${cfg.kinds[k.key] ? "text-violet-300" : "text-term-dim"}`}>
                    {cfg.kinds[k.key] ? "☑" : "☐"}
                  </span>
                  <span>
                    <span className="text-[12px] font-semibold text-term-text">{k.name}</span>
                    <span className="block text-[10.5px] leading-snug text-term-dim">{k.hint}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-1 h-4 text-right text-[11px] text-up">{saved}</div>

            {/* what they'd have said */}
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-term-border pt-2">
              <div className="text-[12px] font-semibold text-term-text">
                Replay · last 3 sessions{" "}
                <span className="font-normal text-term-dim">
                  ({tf / 60} min{rBusy ? ", loading…" : `, ${shown.length} alert${shown.length === 1 ? "" : "s"}`})
                </span>
              </div>
              <div className="seg text-[10.5px]">
                {Array.from(new Set([...cfg.symbols, rSym])).map((s) => (
                  <button key={s} onClick={() => setRSym(s)} className={rSym === s ? "on" : ""}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              {!rBusy && shown.length === 0 && (
                <div className="rounded border border-dashed border-term-border px-3 py-4 text-center text-[11px] text-term-dim">
                  Nothing would have alerted{replay && replay.length ? " for the kinds switched on" : " (no candle data yet)"}.
                </div>
              )}
              {shown.map((e, i) => (
                <div
                  key={i}
                  className={`rounded-md border-l-[3px] bg-term-panel2/60 px-2.5 py-1.5 text-[11.5px] leading-snug text-term-text ${
                    e.kind === "aplus" ? "border-l-amber-400" : e.dir === "up" ? "border-l-up" : "border-l-down"
                  }`}
                >
                  <div className="mb-0.5 text-[10px] text-term-dim">{istTime(e.time)}</div>
                  {e.message}
                </div>
              ))}
            </div>
            <div className="mt-2 text-[10px] leading-snug text-term-dim">
              Up to 12 alerts a day per symbol. They follow Settings → Alerts delivery (Telegram and the symbol filter). A
              pattern, not advice — confirm on the chart.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
