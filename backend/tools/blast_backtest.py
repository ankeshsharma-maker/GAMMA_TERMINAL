"""Back-test (and optionally tune) the gamma-blast scanner on archived sessions.

    python tools/blast_backtest.py <data/history_archive> [--symbol NIFTY ...] [--tune]

Replays every archived row through the real scanner.evaluate(), labels each row
by what the market did NEXT (spot excursion or straddle expansion within the
horizon), then reports how well the score / each component / the alerts predicted
it. --tune fits component weights leave-one-day-out and only recommends them when
there is enough evidence; otherwise it says to keep the current weights.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import scanner  # noqa: E402

KEYS = list(scanner.WEIGHTS)
W0 = dict(scanner.WEIGHTS)
THRESHOLDS = (40, 50, 60, 70, 80)
ALERT_DEDUP_S = 300
MIN_TUNE_DAYS = 8


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def load(archive: Path, symbols: set[str]) -> dict[str, dict[str, list[dict]]]:
    data: dict[str, dict[str, list[dict]]] = {}
    for sd in sorted(p for p in archive.iterdir() if p.is_dir()):
        if symbols and sd.name.upper() not in symbols:
            continue
        for f in sorted(sd.glob("*.jsonl")):
            rows = []
            for line in f.read_text(encoding="utf-8").splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("t") and r.get("spot"):
                    rows.append(r)
            rows.sort(key=lambda r: r["t"])
            if rows:
                data.setdefault(sd.name.upper(), {})[f.stem] = rows
    return data


def chain_of(r: dict) -> dict:
    return {
        "spot": r["spot"], "dte": r.get("dte") if r.get("dte") is not None else 9.0,
        "atmIV": r.get("atmIV"), "atmStraddle": r.get("atmStraddle"),
        "atmGammaOI": r.get("atmGammaOI"), "netGex": r.get("netGex"),
        "maxPain": r.get("maxPain"), "pcr": r.get("pcr"),
        "totals": {"ceOIChg": r.get("ceOIChg") or 0.0, "peOIChg": r.get("peOIChg") or 0.0},
    }


def forward_label(rows: list[dict], i: int, horizon_s: float, kind: str, thresh: float):
    """1/0 for what happens in (t, t+horizon]; None if the day ends first."""
    r = rows[i]
    end = r["t"] + horizon_s
    if rows[-1]["t"] < end:
        return None
    lo = hi = r["spot"] if kind == "spot" else (r.get("atmStraddle") or 0.0)
    base = lo
    if not base:
        return None
    for u in rows[i + 1:]:
        if u["t"] > end:
            break
        v = u["spot"] if kind == "spot" else (u.get("atmStraddle") or base)
        lo, hi = min(lo, v), max(hi, v)
    if kind == "spot":
        return int(max(hi - base, base - lo) / base >= thresh)
    return int((hi - base) / base >= thresh)


def replay(data, horizon_s, kind, thresh, max_dte) -> list[dict]:
    """One sample per evaluable row: components, gate, label."""
    out: list[dict] = []
    span = scanner.WIN_LONG_S + scanner.BASELINE_TOL_S
    for sym, days in data.items():
        for day, rows in days.items():
            lo = 0
            for i, r in enumerate(rows):
                while rows[lo]["t"] < r["t"] - span:
                    lo += 1
                dte = r.get("dte")
                if dte is None or dte > max_dte:
                    continue
                y = forward_label(rows, i, horizon_s, kind, thresh)
                if y is None:
                    continue
                ev = scanner.evaluate(sym, chain_of(r), rows[lo:i + 1], now=r["t"])
                out.append({
                    "sym": sym, "day": day, "t": r["t"], "y": y, "dte": dte,
                    "c": [ev["components"][k] for k in KEYS],
                    "gate": 0.25 + 0.75 * _clamp((2.0 - dte) / 2.0),
                })
    out.sort(key=lambda s: (s["sym"], s["day"], s["t"]))
    return out


def score_of(s: dict, w: dict) -> float:
    return round(100 * s["gate"] * sum(w[k] * c for k, c in zip(KEYS, s["c"])), 1)


def auc(scores: list[float], labels: list[int]):
    n_pos = sum(labels)
    n_neg = len(labels) - n_pos
    if not n_pos or not n_neg:
        return None
    pairs = sorted(zip(scores, labels))
    rank_sum, i, n = 0.0, 0, len(pairs)
    while i < n:
        j = i
        while j + 1 < n and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        rank_sum += ((i + j) / 2 + 1) * sum(l for _, l in pairs[i:j + 1])
        i = j + 1
    return (rank_sum - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def sample_auc(samples, w):
    return auc([score_of(s, w) for s in samples], [s["y"] for s in samples])


def alerts(samples, w, threshold):
    """Edge-triggered crossings, deduped like the live scanner. Returns the
    alert samples and, per (sym, day), the runs of positive rows."""
    fired, prev, last_t, key = [], 0.0, -1e18, None
    for s in samples:
        k = (s["sym"], s["day"])
        if k != key:
            key, prev, last_t = k, 0.0, -1e18
        sc = score_of(s, w)
        if sc >= threshold and prev < threshold and s["t"] - last_t >= ALERT_DEDUP_S:
            fired.append(s)
            last_t = s["t"]
        prev = sc
    return fired


def positive_runs(samples):
    runs, cur, key = [], [], None
    for s in samples:
        k = (s["sym"], s["day"])
        if s["y"] and k == key:
            cur.append(s)
        else:
            if cur:
                runs.append(cur)
            cur = [s] if s["y"] else []
        key = k
    if cur:
        runs.append(cur)
    return runs


def report(samples, w, title):
    days = sorted({s["day"] for s in samples})
    pos = sum(s["y"] for s in samples)
    print(f"\n=== {title} ===")
    a = sample_auc(samples, w)
    print(f"composite AUC: {a:.3f}" if a is not None else "composite AUC: n/a (need both outcomes)")
    runs = positive_runs(samples)
    print(f"{'threshold':>9} {'alerts':>7} {'per day':>8} {'precision':>10} {'events caught':>14}")
    for th in THRESHOLDS:
        fired = alerts(samples, w, th)
        ids = {id(s) for s in fired}
        prec = sum(s["y"] for s in fired) / len(fired) if fired else float("nan")
        caught = sum(1 for r in runs if any(id(s) in ids for s in r))
        print(f"{th:>9} {len(fired):>7} {len(fired) / max(1, len(days)):>8.1f} "
              f"{prec:>10.2f} {caught:>7}/{len(runs)}")
    base = pos / len(samples) if samples else 0
    print(f"(base rate of a blast in the next window: {base:.1%}; precision above that = real signal)")


def component_table(samples):
    print("\n--- per-component AUC (0.5 = no information) ---")
    ys = [s["y"] for s in samples]
    for i, k in enumerate(KEYS):
        a = auc([s["c"][i] for s in samples], ys)
        print(f"  {k:<9} weight {W0[k]:.2f}   AUC " + (f"{a:.3f}" if a is not None else "n/a"))


def fit(samples, w0, lam=0.05, iters=500, seed=0):
    rng = random.Random(seed)
    ys = [s["y"] for s in samples]

    def obj(w):
        a = auc([score_of(s, w) for s in samples], ys)
        return (a if a is not None else 0.5) - lam * sum(abs(w[k] - w0[k]) for k in KEYS)

    w, best = dict(w0), obj(w0)
    for it in range(iters):
        step = 0.08 * (1 - it / iters) + 0.01
        a, b = rng.sample(KEYS, 2)
        if w[b] < step:
            continue
        w2 = dict(w)
        w2[a] += step
        w2[b] -= step
        o = obj(w2)
        if o > best:
            w, best = w2, o
    return w


def tune(samples, iters=500):
    days = sorted({s["day"] for s in samples})
    usable = [d for d in days if 0 < sum(s["y"] for s in samples if s["day"] == d) < sum(1 for s in samples if s["day"] == d)]
    print(f"\n=== tuning (leave-one-day-out) ===\nday(s) with both outcomes: {len(usable)} (need >= {MIN_TUNE_DAYS})")
    deltas = []
    for d in usable:
        train = [s for s in samples if s["day"] != d]
        test = [s for s in samples if s["day"] == d]
        w = fit(train, W0, iters=iters)
        a_new, a_old = sample_auc(test, w), sample_auc(test, W0)
        if a_new is None or a_old is None:
            continue
        deltas.append(a_new - a_old)
        print(f"  held-out {d}: current {a_old:.3f} -> tuned {a_new:.3f} ({a_new - a_old:+.3f})")
    if not deltas:
        print("no usable folds")
        return None
    mean = sum(deltas) / len(deltas)
    wins = sum(1 for x in deltas if x > 0)
    print(f"held-out mean change {mean:+.3f}; tuned better on {wins}/{len(deltas)} days")
    enough = len(usable) >= MIN_TUNE_DAYS and mean >= 0.01 and wins >= 2 * len(deltas) / 3
    if not enough:
        print("VERDICT: keep the current weights -- not enough independent days / no consistent out-of-sample gain.")
        return None
    w = fit(samples, W0, iters=iters)
    print("VERDICT: tuned weights beat the current ones out-of-sample:")
    for k in KEYS:
        print(f"  {k:<9} {W0[k]:.2f} -> {w[k]:.2f}")
    return w


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("archive")
    ap.add_argument("--symbol", action="append", default=[])
    ap.add_argument("--horizon-min", type=float, default=30)
    ap.add_argument("--label", choices=("spot", "straddle"), default="spot")
    ap.add_argument("--blast-pct", type=float, default=None,
                    help="spot label: |move| in %% (default 0.35); straddle label: expansion in %% (default 25)")
    ap.add_argument("--max-dte", type=float, default=1.0)
    ap.add_argument("--tune", action="store_true")
    a = ap.parse_args(argv)
    thresh = (a.blast_pct if a.blast_pct is not None else (0.35 if a.label == "spot" else 25.0)) / 100
    data = load(Path(a.archive), {s.upper() for s in a.symbol})
    if not data:
        print("no archived sessions found")
        return 1
    samples = replay(data, a.horizon_min * 60, a.label, thresh, a.max_dte)
    days = sorted({s["day"] for s in samples})
    print(f"{len(samples)} labelled rows over {len(days)} day(s), symbols {sorted(data)}, "
          f"dte <= {a.max_dte}, label = {a.label} >= {thresh:.2%} within {a.horizon_min:g} min")
    if not samples:
        print("nothing to evaluate (no rows with dte <= max-dte and a full forward window)")
        return 1
    component_table(samples)
    report(samples, W0, "current weights")
    if a.tune:
        w = tune(samples)
        if w:
            report(samples, w, "tuned weights (in-sample -- see the held-out numbers above)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
