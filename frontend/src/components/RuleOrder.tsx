import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nf, sk } from "../lib/format";

const STAT: Record<string, string> = {
  waiting: "text-amber-400",
  active: "text-term-accent",
  done: "text-term-dim",
  cancelled: "text-term-dim",
};

/** Price-triggered conditional order on one option leg: enter when the leg's
 *  LTP crosses a level, then bracket it with SL / trailing SL / target. */
export function RuleOrder({
  symbol,
  expiry,
  strike,
  lots,
}: {
  symbol: string;
  expiry?: string;
  strike: number;
  lots: number;
}) {
  const orderMode = useStore((s) => s.orderMode);
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<any[]>([]);
  const [ot, setOt] = useState<"CE" | "PE">("CE");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [dir, setDir] = useState<"gte" | "lte">("gte");
  const [trig, setTrig] = useState("");
  const [unit, setUnit] = useState<"pts" | "pct" | "rs">("pts");
  const [sl, setSl] = useState("");
  const [tgt, setTgt] = useState("");
  const [trail, setTrail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => api.legRules().then((d) => alive && setRules(d.rules || []), () => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const create = async () => {
    if (!expiry || !strike) return;
    if (!trig) return alert("Set the trigger price");
    if (!sl && !tgt && !trail) return alert("Set a stop-loss, target or trail");
    setBusy(true);
    try {
      const d = await api.legRuleAdd({
        symbol,
        expiry,
        strike,
        optionType: ot,
        side,
        lots,
        mode: orderMode,
        triggerPx: Number(trig),
        triggerDir: dir,
        unit,
        sl: sl || undefined,
        target: tgt || undefined,
        trail: trail || undefined,
      });
      setRules(d.rules || []);
      setTrig("");
      setSl("");
      setTgt("");
      setTrail("");
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: string) => {
    try {
      const d = await api.legRuleDel(id);
      setRules(d.rules || []);
    } catch {
      /* ignore */
    }
  };

  const live = rules.filter((r) => r.status === "waiting" || r.status === "active");

  return (
    <div className="border-b border-term-border text-2xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-1.5 font-semibold uppercase tracking-wide text-term-dim"
      >
        <span>⚡ Rule order{live.length ? ` (${live.length})` : ""}</span>
        <span>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="space-y-1.5 px-3 pb-2">
          <div className="flex flex-wrap items-center gap-1">
            <div className="seg">
              <button className={side === "BUY" ? "on" : ""} onClick={() => setSide("BUY")}>
                Buy
              </button>
              <button className={side === "SELL" ? "on" : ""} onClick={() => setSide("SELL")}>
                Sell
              </button>
            </div>
            <div className="seg">
              <button className={ot === "CE" ? "on" : ""} onClick={() => setOt("CE")}>
                CE
              </button>
              <button className={ot === "PE" ? "on" : ""} onClick={() => setOt("PE")}>
                PE
              </button>
            </div>
            <span className="num text-term-dim">{sk(strike)}</span>
            <span className="ml-auto text-[10px] text-term-dim">×{lots} · {orderMode}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-term-dim">LTP</span>
            <div className="seg">
              <button className={dir === "gte" ? "on" : ""} onClick={() => setDir("gte")}>
                ≥
              </button>
              <button className={dir === "lte" ? "on" : ""} onClick={() => setDir("lte")}>
                ≤
              </button>
            </div>
            <input
              value={trig}
              onChange={(e) => setTrig(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="trigger ₹"
              className="num w-20 rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-term-text outline-none focus:border-term-accent"
            />
            <div className="seg ml-auto">
              {(["pts", "pct", "rs"] as const).map((u) => (
                <button key={u} className={unit === u ? "on" : ""} onClick={() => setUnit(u)}>
                  {u === "pts" ? "Pts" : u === "pct" ? "%" : "₹"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {(
              [
                ["SL", sl, setSl],
                ["Target", tgt, setTgt],
                ["Trail", trail, setTrail],
              ] as const
            ).map(([lbl, val, set]) => (
              <label key={lbl} className="flex flex-1 items-center gap-1 text-term-dim">
                {lbl}
                <input
                  value={val}
                  onChange={(e) => set(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="0"
                  className="num w-full min-w-0 rounded border border-term-border bg-term-bg px-1 py-0.5 text-term-text outline-none focus:border-term-accent"
                />
              </label>
            ))}
          </div>

          <button
            onClick={create}
            disabled={busy || !expiry}
            className="btn btn-buy w-full py-1 font-semibold disabled:opacity-40"
          >
            {busy ? "…" : `Create rule — ${side} ${sk(strike)} ${ot}`}
          </button>

          {rules.length > 0 && (
            <div className="mt-1 space-y-1">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded border border-term-border/60 px-2 py-1"
                >
                  <div className="min-w-0 leading-tight">
                    <div className="num truncate">
                      {r.side} {sk(r.strike)} {r.optionType} ×{r.lots}{" "}
                      <span className="text-term-dim">
                        @ LTP {r.triggerDir === "gte" ? "≥" : "≤"} {nf(r.triggerPx, 2)}
                      </span>
                    </div>
                    <div className="text-[10px] text-term-dim">
                      {[
                        r.sl != null && `SL ${r.sl}`,
                        r.target != null && `tgt ${r.target}`,
                        r.trail != null && `trail ${r.trail}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}{" "}
                      {r.unit} ·{" "}
                      <span className={STAT[r.status] ?? ""}>
                        {r.status}
                        {r.entryPx ? ` @${nf(r.entryPx, 1)}` : ""}
                        {r.exitReason ? ` (${r.exitReason})` : ""}
                      </span>
                    </div>
                  </div>
                  {(r.status === "waiting" || r.status === "active") && (
                    <button
                      onClick={() => del(r.id)}
                      className="shrink-0 rounded px-1.5 text-term-dim hover:text-down"
                      title="Cancel rule"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
