"""What-if grid for everything that is open right now.

Reprices every open option / future leg under a spot shock x an IV shift x days
forward and sums the change, so "what does NIFTY -1.5% with IV +3 points do to
my book?" is one lookup instead of a guess. It works across underlyings at once
(each is shocked by the same percentage -- a beta-1 assumption, stated in the UI)
and across paper and broker positions.

Each option's IV is solved from its own mark (LTP), not taken from the chain, so
the model reproduces the position's current price and the centre cell of the grid
is exactly today's P&L. Scenario cells are model prices minus the model price
today, added to the P&L already on the book.
"""
from __future__ import annotations

import logging
import math
import re
from datetime import datetime
from typing import Awaitable, Callable

from .config import DIVIDEND_YIELD as Q
from .config import RISK_FREE_RATE as R
from .greeks import bs_price, greeks as bs_greeks, implied_vol
from .processing import _MIN_T, lot_size, year_fraction

log = logging.getLogger("gamma.scenario")

SPOT_SHOCKS = [-5.0, -3.0, -2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0, 3.0, 5.0]   # % of spot
IV_SHIFTS = [-6.0, -4.0, -2.0, 0.0, 2.0, 4.0, 6.0]                            # vol points
_FUT_TSYM = re.compile(r"^(?P<name>[A-Z0-9&\-]+?)(?P<date>\d{2}[A-Z]{3}\d{2})F$")


# ---------------------------------------------------------------- positions in
def from_paper(positions: list[dict]) -> list[dict]:
    out = []
    for p in positions or []:
        qty = float(p.get("qty") or 0)
        if not qty:
            continue
        avg = float(p.get("avgPrice") or 0)
        out.append({
            "source": "paper", "symbol": str(p["symbol"]).upper(), "expiry": p["expiry"],
            "strike": float(p.get("strike") or 0.0), "type": p["optionType"], "qty": qty,
            "entry": avg, "ltp": float(p.get("ltp") or avg),
        })
    return out


def from_broker(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """Open option and future legs from Flattrade PositionBook rows; anything
    else (equity, an unrecognised symbol) is returned as `skipped`."""
    from .brokers.flattrade import parse_noren_tsym

    out: list[dict] = []
    skipped: list[str] = []
    for r in rows or []:
        try:
            qty = float(r.get("netqty") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        if not qty:
            continue
        tsym = str(r.get("tsym") or "")
        entry = _f(r.get("netavgprc") or r.get("daybuyavgprc") or r.get("daysellavgprc"))
        ltp = _f(r.get("lp")) or entry
        parsed = parse_noren_tsym(tsym)
        if parsed:
            out.append({"source": "broker", "symbol": parsed["symbol"], "expiry": parsed["expiry"],
                        "strike": parsed["strike"], "type": parsed["optionType"], "qty": qty,
                        "entry": entry, "ltp": ltp})
            continue
        m = _FUT_TSYM.match(tsym.upper())
        if m:
            try:
                exp = datetime.strptime(m["date"], "%d%b%y").strftime("%d-%b-%Y")
            except ValueError:
                exp = None
            if exp:
                out.append({"source": "broker", "symbol": m["name"], "expiry": exp, "strike": 0.0,
                            "type": "FUT", "qty": qty, "entry": entry, "ltp": ltp})
                continue
        skipped.append(f"{r.get('exch')}:{tsym}")
    return out, skipped


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------- pricing
def _price(kind: str, s: float, k: float, t_years: float, sigma: float) -> float:
    if t_years <= 0:
        return max((s - k) if kind == "CE" else (k - s), 0.0)      # past expiry: intrinsic
    return bs_price(kind, s, k, max(t_years, 1e-6), R, Q, max(sigma, 0.01))


def _leg_model(p: dict, spot: float, atm_iv: float, chain_iv: float | None) -> dict:
    """IV (solved from the mark), and today's model price / Greeks for one option leg."""
    kind, k = p["type"], p["strike"]
    t0 = year_fraction(p["expiry"])
    tc = max(t0, _MIN_T)               # the same floor the chain's own Greeks use
    iv = implied_vol(kind, p["ltp"], spot, k, tc, R, Q) if p["ltp"] > 0 else None
    src = "mark"
    if iv is None:
        iv, src = ((chain_iv / 100.0), "chain") if chain_iv else (atm_iv, "atm")
    return {"t0": t0, "tc": tc, "iv": iv, "ivSource": src,
            "p0": bs_price(kind, spot, k, tc, R, Q, iv), "g": bs_greeks(kind, spot, k, tc, R, Q, iv)}


# ---------------------------------------------------------------- the grid
async def build(
    positions: list[dict],
    get_chain: Callable[[str, str], Awaitable[dict]],
    days_forward: float = 0.0,
    skipped: list[str] | None = None,
) -> dict:
    if days_forward < 0:   # "to expiry": the nearest expiry among the open legs
        dtes = [year_fraction(p["expiry"]) * 365.0 for p in positions]
        days_forward = (min(dtes) + 1e-6) if dtes else 0.0
    days_forward = max(0.0, min(float(days_forward), 60.0))
    chains: dict[tuple, dict] = {}
    errors: list[dict] = []
    for sym, exp in sorted({(p["symbol"], p["expiry"]) for p in positions if p["type"] != "FUT"}):
        try:
            chains[(sym, exp)] = await get_chain(sym, exp)
        except Exception as exc:  # noqa: BLE001 -- HTTPException carries .detail
            errors.append({"symbol": sym, "expiry": exp, "error": str(getattr(exc, "detail", exc))})

    n_iv, n_sp = len(IV_SHIFTS), len(SPOT_SHOCKS)
    total = [[0.0] * n_sp for _ in range(n_iv)]
    net = {"delta": 0.0, "deltaRs1pct": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    by_u: dict[str, dict] = {}
    legs_out: list[dict] = []
    current = 0.0
    unpriced = 0

    for p in positions:
        sym, qty = p["symbol"], p["qty"]
        pnl_now = qty * (p["ltp"] - p["entry"])
        current += pnl_now
        row = {
            "source": p["source"], "symbol": sym, "expiry": p["expiry"], "strike": p["strike"],
            "type": p["type"], "qty": qty, "lots": round(qty / max(lot_size(sym), 1), 2),
            "entry": round(p["entry"], 2), "ltp": round(p["ltp"], 2), "pnl": round(pnl_now, 2),
            "priced": False, "iv": None, "grid": None,
        }
        u = by_u.setdefault(sym, {"symbol": sym, "spot": None, "pnl": 0.0, "delta": 0.0,
                                  "deltaRs1pct": 0.0, "theta": 0.0, "vega": 0.0, "atmIV": None})
        u["pnl"] += pnl_now

        if p["type"] == "FUT":
            spot = p["ltp"]
            if u["spot"] is None:
                u["spot"] = spot
            grid = [[qty * spot * x / 100.0 for x in SPOT_SHOCKS] for _ in IV_SHIFTS]
            d = qty
            row.update(priced=True, grid=_r2(grid), delta=round(d, 2), gamma=0.0, theta=0.0, vega=0.0)
            th = ga = vg = 0.0
        else:
            ch = chains.get((sym, p["expiry"]))
            if ch is None:
                unpriced += 1
                legs_out.append(row)
                continue
            spot = ch.get("liveSpot") or ch["spot"]
            u["spot"] = spot
            u["atmIV"] = ch.get("atmIV")
            atm_iv = (ch.get("atmIV") or 15.0) / 100.0
            rw = next((r for r in ch["rows"] if r["strike"] == p["strike"]), None)
            chain_iv = None
            if rw:
                leg = rw["call"] if p["type"] == "CE" else rw["put"]
                chain_iv = leg.get("ivCalc") or leg.get("iv")
            m = _leg_model(p, spot, atm_iv, chain_iv)
            t_s = m["t0"] - days_forward / 365.0
            grid = []
            for dv in IV_SHIFTS:
                line = []
                for x in SPOT_SHOCKS:
                    s2 = spot * (1.0 + x / 100.0)
                    if days_forward <= 0:
                        px = _price(p["type"], s2, p["strike"], m["tc"], m["iv"] + dv / 100.0)
                    else:
                        px = _price(p["type"], s2, p["strike"], t_s, m["iv"] + dv / 100.0)
                    line.append(qty * (px - m["p0"]))
                grid.append(line)
            g = m["g"]
            d = qty * g["delta"]
            ga, th, vg = qty * g["gamma"], qty * g["theta"], qty * g["vega"]
            row.update(priced=True, iv=round(m["iv"] * 100.0, 2), ivSource=m["ivSource"], grid=_r2(grid),
                       delta=round(d, 2), gamma=round(ga, 5), theta=round(th, 2), vega=round(vg, 2))
            net["gamma"] += ga * spot * 0.01     # change in net delta (units) for a 1% move
        net["delta"] += d
        net["deltaRs1pct"] += d * spot * 0.01
        net["theta"] += th
        net["vega"] += vg
        u["delta"] += d
        u["deltaRs1pct"] += d * spot * 0.01
        u["theta"] += th
        u["vega"] += vg
        for i in range(n_iv):
            for j in range(n_sp):
                total[i][j] += row["grid"][i][j]
        legs_out.append(row)

    cells = [(total[i][j], i, j) for i in range(n_iv) for j in range(n_sp)]
    worst = min(cells) if cells else None
    best = max(cells) if cells else None
    dtes = [max(year_fraction(p["expiry"]) * 365.0, 0.0) for p in positions]
    return {
        "spotShocks": SPOT_SHOCKS,
        "ivShifts": IV_SHIFTS,
        "daysForward": days_forward,
        "nearestDte": round(min(dtes), 2) if dtes else None,
        "current": round(current, 2),
        "grid": _r2(total),
        "positions": legs_out,
        "greeks": {k: round(v, 3 if k == "gamma" else 1) for k, v in net.items()},
        "byUnderlying": [
            {**u, **{k: round(u[k], 1) for k in ("pnl", "delta", "deltaRs1pct", "theta", "vega")},
             "sigma1dPct": round(u["atmIV"] * math.sqrt(1.0 / 365.0), 2) if u["atmIV"] else None}
            for u in by_u.values()
        ],
        "worst": {"delta": round(worst[0], 2), "iv": IV_SHIFTS[worst[1]], "spot": SPOT_SHOCKS[worst[2]]} if worst else None,
        "best": {"delta": round(best[0], 2), "iv": IV_SHIFTS[best[1]], "spot": SPOT_SHOCKS[best[2]]} if best else None,
        "errors": errors,
        "skipped": skipped or [],
        "partial": bool(unpriced),
    }


def _r2(grid: list[list[float]]) -> list[list[float]]:
    return [[round(v, 2) for v in row] for row in grid]
