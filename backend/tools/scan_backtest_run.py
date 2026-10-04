"""Run the Scan-tab backtests over folders of daily candles and print one line per signal.

    python tools/scan_backtest_run.py LABEL=DIR [LABEL=DIR ...] [--min-cr 5] [--only wk,gap] [--json out.json]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import scan_backtest as B  # noqa: E402

BATTERY = [
    ("volbuild", {"min": 1.5}), ("volbuild", {"min": 2.0}), ("volbuild", {"min": 3.0}),
    ("dma", {"pick": "above3"}), ("dma", {"pick": "below3"}), ("dma", {"pick": "above200"}), ("dma", {"pick": "below200"}),
    ("wk", {"side": "UP"}), ("wk", {"side": "DOWN"}), ("mo", {"side": "UP"}), ("mo", {"side": "DOWN"}),
    ("setup", {"which": "nr7"}), ("setup", {"which": "inside"}), ("setup", {"which": "both"}),
    ("volbreak", {"min": 2.0, "side": "UP"}), ("volbreak", {"min": 3.0, "side": "UP"}),
    ("volbreak", {"min": 2.0, "side": "DOWN"}), ("volbreak", {"min": 3.0, "side": "DOWN"}),
    ("mover", {"pct": 3, "side": "UP"}), ("mover", {"pct": 5, "side": "UP"}),
    ("mover", {"pct": 3, "side": "DOWN"}), ("mover", {"pct": 5, "side": "DOWN"}),
    ("w52", {"side": "UP"}), ("w52", {"side": "DOWN"}),
    ("gap", {"pct": 2, "side": "UP", "state": "hold"}), ("gap", {"pct": 2, "side": "UP", "state": "filled"}),
    ("gap", {"pct": 2, "side": "DOWN", "state": "hold"}), ("gap", {"pct": 2, "side": "DOWN", "state": "filled"}),
]


def label(scan: str, p: dict) -> str:
    return scan + " " + " ".join(f"{k}={v}" for k, v in p.items())


def main() -> None:
    a = sys.argv[1:]

    def opt(name, default, cast=str):
        if name in a:
            i = a.index(name)
            v = cast(a[i + 1])
            del a[i : i + 2]
            return v
        return default

    min_cr = opt("--min-cr", 5.0, float)
    only = opt("--only", "", str).split(",") if "--only" in a else None
    out_json = opt("--json", "", str)
    sets = [x.split("=", 1) for x in a if "=" in x]
    allres = {}
    for lab, d in sets:
        t0 = time.time()
        stocks = B.load_dir(d)
        base = B.baseline(stocks, min_cr * 1e7)
        print(f"\n##### {lab}: {len(stocks)} stocks, min traded {min_cr} Cr/day  (baseline in {time.time() - t0:.0f}s)")
        print(f"{'signal':<34}{'fires':>6} | " + " | ".join(f"{h:>2}d  n    avg   edge   t   tc" for h in (1, 5, 20)))
        for scan, p in BATTERY:
            if only and scan not in only:
                continue
            r = B.run(stocks, scan, p, min_cr, base)
            allres[f"{lab}|{label(scan, p)}"] = r
            cells = []
            for hz in r["horizons"]:
                if hz["h"] in (1, 5, 20):
                    cells.append(f"{hz['n']:>5} {hz.get('avg', 0):+6.2f} {hz.get('edge', 0):+6.2f} {hz.get('t') or 0:+5.1f} {hz.get('tc') or 0:+5.1f}" if hz["n"] else "   -")
            print(f"{label(scan, p):<34}{r['fires']:>6} | " + " | ".join(cells))
    if out_json:
        Path(out_json).write_text(json.dumps(allres), "utf-8")


if __name__ == "__main__":
    main()
