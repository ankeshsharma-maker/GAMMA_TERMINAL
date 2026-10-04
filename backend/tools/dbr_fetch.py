"""Download daily candles (several years) for a list of stocks into a folder of JSON files,
for tools/dbr_backtest.py. Run it ON THE SERVER (it needs the Upstox token), one stock at a time,
paced like the app's own volume baseline (0.9 s apart, waits while Upstox is refusing calls):

    cd /opt/gammaterminal/backend && venv/bin/python tools/dbr_fetch.py OUTDIR [--years 5] [--limit N] [SYM ...]

With no symbols it takes the F&O stock universe. Existing files are skipped, so it can be re-run.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


async def main() -> None:
    from app import config  # noqa: F401  (loads .env)
    from app.brokers.upstox import get_upstox
    from app.upstox_data import _hc, rate_limited
    from app.volume_screener import fo_stocks

    args = sys.argv[1:]
    out = Path(args.pop(0))
    years, limit = 5, 0
    if "--years" in args:
        i = args.index("--years")
        years = int(args[i + 1])
        del args[i : i + 2]
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        del args[i : i + 2]
    syms = [a.upper() for a in args] or fo_stocks()
    if limit:
        syms = syms[:limit]
    out.mkdir(parents=True, exist_ok=True)
    ux = get_upstox()
    if not ux.authed:
        sys.exit("Upstox is not authenticated here")
    await ux.load_instruments()
    today = date.today()
    got = 0
    for n, sym in enumerate(syms, 1):
        f = out / f"{sym}.json"
        if f.exists():
            continue
        key = ux.underlying_key(sym)
        if not key:
            print(sym, "no instrument key", flush=True)
            continue
        while rate_limited():
            await asyncio.sleep(5)
        try:
            h = await ux.get(_hc(key, "days", 1, today.isoformat(), (today - timedelta(days=365 * years + 30)).isoformat()), v3=True)
        except Exception as exc:  # noqa: BLE001
            print(sym, "failed:", exc, flush=True)
            await asyncio.sleep(10)
            continue
        cs = (h.get("data") or {}).get("candles") or []  # newest first: [ts, o, h, l, c, v, oi]
        if cs:
            f.write_text(json.dumps(cs, separators=(",", ":")), "utf-8")
            got += 1
        print(f"{n}/{len(syms)} {sym}: {len(cs)} candles ({str(cs[-1][0])[:10] if cs else '-'} -> {str(cs[0][0])[:10] if cs else '-'})", flush=True)
        await asyncio.sleep(0.9)
    print("done:", got, "files in", out)


if __name__ == "__main__":
    asyncio.run(main())
