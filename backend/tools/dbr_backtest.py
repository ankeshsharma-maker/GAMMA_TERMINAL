"""Backtest of the drop-base-rally demand zones (app/dbr_zones.py) on daily candles.

    python tools/dbr_backtest.py CANDLE_DIR [--hold 20] [--cost 0.10] [--wait 60] [--json out.json]

CANDLE_DIR holds one SYM.json per stock (tools/dbr_fetch.py): [[ts,o,h,l,c,v,oi], ...] newest first.

Rules, chosen so nothing can look ahead:
  * A zone exists from the close of its rally candle on (every number in it comes from candles up to
    and including that one -- detection runs on the prefix only).
  * ENTRY = the first session within --wait sessions whose low reaches the zone top (the "fresh zone
    touched" moment the Telegram alert fires on). A limit buy at the zone top; if the session OPENS
    below the top the fill is the open; if it opens below the zone's low the zone is dead, no trade.
  * STOP = the zone's low. If the entry session itself trades through the stop the trade is a loss.
  * TARGET = where the drop began. Only checked from the session AFTER entry. A gap through either level
    fills at the open. If one session spans both stop and target the STOP wins (pessimistic).
  * TIME EXIT at the close of the --hold'th session after entry.
  * R = (exit - entry) / (entry - stop). Costs (--cost, % of entry, round trip) are taken off.
A CONTROL runs the same stop %, target % and time exit from random days of the same stocks, so the zones
have to beat "buy anything with this stop and target" to count as an edge.
"""
from __future__ import annotations

import json
import random
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import dbr_zones as Z  # noqa: E402


def load(d: Path) -> dict[str, list[dict]]:
    out = {}
    for f in sorted(d.glob("*.json")):
        cs = Z._bars(json.loads(f.read_text("utf-8")))
        if len(cs) > 250:
            out[f.stem] = cs
    return out


def zones(cs: list[dict]) -> list[tuple[int, dict]]:
    """Every zone, as known at its rally candle (prefix-only detection), de-duplicated."""
    atr = Z._atr(cs)
    found, last_r = [], -99
    for r in range(Z.ATR_N + 4, len(cs)):
        z = Z._try(cs[: r + 1], atr[: r + 1], r)
        if z and r - last_r > 5:  # neighbouring rally candles of one move are one zone
            found.append((r, z))
            last_r = r
    return found


def run_trade(cs, entry_i, entry_px, stop, target, hold):
    """-> (exit_px, exit_i, how) walking forward from the entry session."""
    if cs[entry_i]["l"] <= stop:
        return stop, entry_i, "stop"
    last = min(entry_i + hold, len(cs) - 1)
    for e in range(entry_i + 1, last + 1):
        x = cs[e]
        if x["o"] <= stop:
            return x["o"], e, "stop"
        if x["l"] <= stop:
            return stop, e, "stop"
        if x["o"] >= target:
            return x["o"], e, "target"
        if x["h"] >= target:
            return target, e, "target"
    if last == entry_i + hold:
        return cs[last]["c"], last, "time"
    return None, last, "open"  # ran out of data: not counted


def zone_trade(cs, r, z, wait, hold, cost, buf=0.0, tp=0.0):
    # buf = put the stop this % below the zone low; tp = a fixed target of tp x the risk (0 = where the drop began)
    prox, dist, tgt = z["prox"], z["dist"] * (1 - buf / 100), z["tgt"]
    for d in range(r + 1, min(r + wait, len(cs) - 1) + 1):
        x = cs[d]
        if x["o"] < dist:
            return {"why": "dead"}  # gapped / closed through the zone before it was ever touched
        if x["l"] <= prox:
            entry = min(x["o"], prox)
            if entry <= dist:
                return {"why": "dead"}
            tgt = entry + tp * (entry - dist) if tp else tgt
            px, ei, how = run_trade(cs, d, entry, dist, tgt, hold)
            if how == "open":
                return {"why": "open"}
            risk = (entry - dist) / entry * 100
            return {"why": "trade", "i": d, "entry": entry, "exit": px, "how": how, "days": ei - d,
                    "riskPct": risk, "ret": (px / entry - 1) * 100 - cost,
                    "R": ((px - entry) / (entry - dist)) - cost / risk, "date": x["d"], "tgtPct": (tgt / entry - 1) * 100}
    return {"why": "untouched"}


def control(cs, riskPct, tgtPct, hold, cost, rng, n):
    out = []
    for _ in range(n):
        i = rng.randrange(60, len(cs) - hold - 2)
        entry = cs[i]["c"]
        stop, tgt = entry * (1 - riskPct / 100), entry * (1 + tgtPct / 100)
        px, ei, how = run_trade(cs, i, entry, stop, tgt, hold)
        if how == "open":
            continue
        out.append(((px - entry) / (entry - stop)) - cost / riskPct)
    return out


def summarize(rows: list[dict]) -> str:
    n = len(rows)
    if not n:
        return "no trades"
    R = [t["R"] for t in rows]
    wins = sum(1 for t in rows if t["R"] > 0)
    gp = sum(r for r in R if r > 0)
    gl = -sum(r for r in R if r < 0)
    how = defaultdict(int)
    for t in rows:
        how[t["how"]] += 1
    return (f"n={n:<5} win {wins / n * 100:4.1f}%  avgR {st.mean(R):+.2f}  medR {st.median(R):+.2f}  "
            f"PF {gp / gl if gl else float('inf'):.2f}  ret {st.mean(t['ret'] for t in rows):+.2f}%  "
            f"tgt {how['target'] / n * 100:3.0f}% stop {how['stop'] / n * 100:3.0f}% time {how['time'] / n * 100:3.0f}%  "
            f"days {st.mean(t['days'] for t in rows):.1f}")


def main() -> None:
    a = sys.argv[1:]
    d = Path(a.pop(0))

    def opt(name, default, cast=float):
        if name in a:
            i = a.index(name)
            v = cast(a[i + 1])
            del a[i : i + 2]
            return v
        return default

    hold, cost, wait = opt("--hold", 20, int), opt("--cost", 0.10), opt("--wait", 60, int)
    out_json = opt("--json", "", str)
    buf, tp = opt("--buf", 0.0), opt("--tp", 0.0)
    data = load(d)
    print(f"{len(data)} stocks, hold {hold} sessions, cost {cost}% round trip, wait {wait} sessions, stop buffer {buf}%, target {tp or 'where the drop began'}\n")
    rng = random.Random(7)
    trades, ctrl = [], []
    funnel = defaultdict(int)
    for sym, cs in data.items():
        for r, z in zones(cs):
            funnel["zones"] += 1
            t = zone_trade(cs, r, z, wait, hold, cost, buf, tp)
            funnel[t["why"]] += 1
            if t["why"] != "trade":
                continue
            # skip a trade whose window contains a split-like jump
            seg = cs[r - 1 : t["i"] + hold + 2]
            if any(seg[k - 1]["c"] and abs(seg[k]["c"] / seg[k - 1]["c"] - 1) > Z.CA_JUMP for k in range(1, len(seg))):
                funnel["split-skipped"] += 1
                continue
            t.update({"sym": sym, "trend": z["trend"], "rvol": z["rvol"], "rr": z["rr"], "base": z["base"], "score": z["score"],
                      "year": t["date"][:4], "drop": z["drop"]})
            trades.append(t)
            ctrl += control(cs, t["riskPct"], t["tgtPct"], hold, cost, rng, 5)
    print("funnel:", dict(funnel), "\n")
    print("ALL ZONES, first touch    ", summarize(trades))
    if ctrl:
        gp = sum(r for r in ctrl if r > 0)
        gl = -sum(r for r in ctrl if r < 0)
        print(f"CONTROL (random days, same stop/target)  n={len(ctrl)}  win {sum(1 for r in ctrl if r > 0) / len(ctrl) * 100:4.1f}%  "
              f"avgR {st.mean(ctrl):+.2f}  medR {st.median(ctrl):+.2f}  PF {gp / gl if gl else float('inf'):.2f}")
    print("\nBY FILTER")
    groups = {
        "above 50-DMA": lambda t: t["trend"],
        "below 50-DMA": lambda t: not t["trend"],
        "rally vol >= 1.5x": lambda t: (t["rvol"] or 0) >= 1.5,
        "rally vol >= 2.5x": lambda t: (t["rvol"] or 0) >= 2.5,
        "RR >= 2": lambda t: (t["rr"] or 0) >= 2,
        "RR >= 3": lambda t: (t["rr"] or 0) >= 3,
        "1-candle base": lambda t: t["base"] == 1,
        "3+ candle base": lambda t: t["base"] >= 3,
        "score >= 60": lambda t: t["score"] >= 60,
        "score >= 75": lambda t: t["score"] >= 75,
        "trend + vol1.5 + RR2": lambda t: t["trend"] and (t["rvol"] or 0) >= 1.5 and (t["rr"] or 0) >= 2,
        "risk <= 3%": lambda t: t["riskPct"] <= 3,
        "risk > 3%": lambda t: t["riskPct"] > 3,
    }
    for name, f in groups.items():
        print(f"{name:<22}", summarize([t for t in trades if f(t)]))
    print("\nBY YEAR")
    for y in sorted({t["year"] for t in trades}):
        print(f"{y:<22}", summarize([t for t in trades if t["year"] == y]))
    if out_json:
        Path(out_json).write_text(json.dumps(trades), "utf-8")


if __name__ == "__main__":
    main()
