"""Volatility analytics for one underlying.

* smile / skew -- the IV of every strike (the out-of-the-money side, the way a
  vol surface is normally read) for each of the next few expiries, plus the
  25-delta risk reversal and butterfly that summarise its tilt and curvature;
* term structure -- ATM IV per expiry, the 1-sigma move it implies, and a
  constant-maturity 30-day IV interpolated in total variance;
* implied vs realized -- close-to-close realized vol over 5/10/20/30 days, where
  today's 20-day figure sits against the past year (a "cone"), and the gap
  between 30-day IV and 20-day realized vol;
* summary -- all of the above in plain words: are options expensive or cheap,
  the range the market expects, what it is afraid of, whether a near-term event
  is priced in. Rules of thumb for reading the numbers, not a trading signal.

Everything is derived from data the app already holds (the processed option
chains and the underlying's candles); the only extra fetches are the chains of
the later expiries, which are cached and refreshed at most every 90 seconds.
"""
from __future__ import annotations

import logging
import math
import statistics
import time
from datetime import datetime

from . import candle_sources
from .nse_client import client
from .processing import IST
from .store import store

log = logging.getLogger("gamma.vol")

MAX_EXPIRIES = 6
TARGET_DAYS = 35          # keep adding expiries until the curve reaches about a month out
CHAIN_MAX_AGE = 90.0      # seconds a non-front chain may be reused before it is re-fetched
_TTL = 45.0
_RV_TTL = 300.0
_CACHE: dict[str, tuple[float, dict]] = {}
_RV_CACHE: dict[str, tuple[float, dict]] = {}


# ---------------------------------------------------------------- smile / skew
def _leg_iv(leg: dict) -> float | None:
    iv = leg.get("ivCalc") or leg.get("iv")
    return iv if iv and 0 < iv < 250 else None


def _quoted(leg: dict) -> bool:
    """A leg with no trade and no two-sided quote has a stale IV -- leave it off the smile."""
    return (leg.get("ltp") or 0) > 0 or ((leg.get("bid") or 0) > 0 and (leg.get("ask") or 0) > 0)


SPIKE_REL, SPIKE_FLOOR = 0.20, 2.0   # drop a point this far (relative, and in vol points) from its neighbours


def _despike(pts: list[dict]) -> list[dict]:
    """Drop isolated junk points. Thin strikes carry one-sided or stale quotes whose
    IV jumps several points off the curve; a real smile is smooth from strike to
    strike, so a point far from the median of its four neighbours is noise. (The
    steep wings of a near expiry are safe: their neighbours sit on both sides.)"""
    ivs = [p["iv"] for p in pts]
    keep = []
    for i, p in enumerate(pts):
        nb = ivs[max(0, i - 2):i] + ivs[i + 1:i + 3]
        if len(nb) >= 3:
            med = statistics.median(nb)
            if abs(p["iv"] - med) > max(SPIKE_FLOOR, SPIKE_REL * med):
                continue
        keep.append(p)
    return keep


def smile_points(chain: dict) -> list[dict]:
    """One point per strike: the OTM leg's IV (puts below ATM, calls above, the
    average of both at ATM), with isolated junk quotes removed."""
    spot = chain["spot"]
    atm = chain["atmStrike"]
    out: list[dict] = []
    for r in chain["rows"]:
        k = r["strike"]
        civ = _leg_iv(r["call"]) if _quoted(r["call"]) else None
        piv = _leg_iv(r["put"]) if _quoted(r["put"]) else None
        if k < atm:
            iv = piv or civ
        elif k > atm:
            iv = civ or piv
        else:
            vals = [v for v in (civ, piv) if v]
            iv = sum(vals) / len(vals) if vals else None
        if iv is None:
            continue
        out.append({
            "strike": k,
            "m": round((k / spot - 1.0) * 100.0, 3),
            "iv": round(iv, 2),
            "callIV": round(civ, 2) if civ else None,
            "putIV": round(piv, 2) if piv else None,
        })
    return _despike(out)


def _iv_at_delta(chain: dict, side: str, target: float = 0.25) -> float | None:
    """IV where |delta| crosses `target`, interpolated linearly in delta."""
    seq = []
    for r in chain["rows"]:
        leg = r[side]
        d = abs(leg.get("delta") or 0.0)
        iv = _leg_iv(leg) if _quoted(leg) else None
        if iv and 0.01 < d < 0.99:
            seq.append((d, iv))
    seq.sort()
    for (d0, v0), (d1, v1) in zip(seq, seq[1:]):
        if d0 <= target <= d1 and d1 > d0:
            return v0 + (v1 - v0) * (target - d0) / (d1 - d0)
    return None


WING_SANITY = 0.45   # a 25-delta wing this far from ATM IV is a junk quote, not skew


def skew_metrics(chain: dict) -> dict:
    atm = chain.get("atmIV")
    # Deep-OTM strikes in a thin expiry can carry a stale or one-sided mid whose IV is
    # nonsense (seen live: a 25-delta put at +57% of ATM in an otherwise smooth smile).
    # Better a dash than a confident wrong number.
    sane = lambda v: v if v is not None and atm and abs(v / atm - 1.0) <= WING_SANITY else None  # noqa: E731
    c25 = sane(_iv_at_delta(chain, "call"))
    p25 = sane(_iv_at_delta(chain, "put"))
    rr = c25 - p25 if c25 is not None and p25 is not None else None
    fly = (c25 + p25) / 2.0 - atm if c25 is not None and p25 is not None and atm else None
    return {
        "call25": _r(c25, 2),
        "put25": _r(p25, 2),
        # negative = puts are bid over calls (the usual equity-index tilt)
        "rr25": _r(rr, 2),
        # positive = the wings are richer than the middle
        "fly25": _r(fly, 2),
    }


def _r(v: float | None, nd: int) -> float | None:
    return None if v is None else round(v, nd)


# ---------------------------------------------------------------- term structure
def expiry_summary(chain: dict) -> dict:
    spot = chain["spot"]
    dte = chain["dte"]
    iv = chain.get("atmIV")
    straddle = chain.get("atmStraddle")
    sigma_move = iv / 100.0 * math.sqrt(max(dte, 0.0) / 365.0) * 100.0 if iv else None
    return {
        "expiry": chain["expiry"],
        "dte": dte,
        "atmStrike": chain["atmStrike"],
        "atmIV": iv,
        "straddle": straddle,
        # 1-sigma move to expiry from ATM IV, and what the ATM straddle is pricing (~0.8 sigma)
        "sigmaMovePct": _r(sigma_move, 2),
        "straddleMovePct": _r(straddle / spot * 100.0, 2) if straddle and spot else None,
        **skew_metrics(chain),
    }


def constant_maturity_iv(term: list[dict], days: float) -> float | None:
    """IV at a fixed horizon, interpolating total variance (sigma^2 * T) linearly
    between the two expiries that bracket it -- flat outside the curve."""
    pts = sorted((t["dte"], t["atmIV"]) for t in term if t.get("atmIV") and t["dte"] > 0)
    if not pts:
        return None
    if days <= pts[0][0]:
        return pts[0][1]
    if days >= pts[-1][0]:
        return pts[-1][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t0 <= days <= t1:
            w0, w1 = (v0 / 100.0) ** 2 * t0, (v1 / 100.0) ** 2 * t1
            w = w0 + (w1 - w0) * (days - t0) / (t1 - t0)
            return math.sqrt(w / days) * 100.0
    return None


# ---------------------------------------------------------------- realized vol
def _daily_closes(candles: list[dict]) -> list[tuple]:
    """(date, close) per IST trading day from candles of ANY resolution (the last
    candle of each day wins), so a 4h broker fallback works as well as daily bars."""
    by_day: dict = {}
    for c in sorted(candles, key=lambda c: c["time"]):
        if c.get("close") and c["close"] > 0:
            by_day[datetime.fromtimestamp(c["time"], IST).date()] = c["close"]
    return sorted(by_day.items())


def _log_returns(closes: list[float]) -> list[float]:
    return [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]


def _stdev_ann(rets: list[float], per_year: float) -> float | None:
    if len(rets) < 2:
        return None
    return statistics.stdev(rets) * math.sqrt(per_year) * 100.0


def realized(closes_dated: list[tuple]) -> dict:
    closes = [c for _, c in closes_dated]
    rets = _log_returns(closes)
    out: dict = {"days": len(rets)}
    for n in (5, 10, 20, 30):
        out[f"rv{n}"] = _r(_stdev_ann(rets[-n:], 252) if len(rets) >= n else None, 2)

    # rolling 20-day series (for the chart) and the cone of the past year
    cones: dict = {}
    series: list[dict] = []
    for n in (10, 20, 30):
        roll = []
        for i in range(n, len(rets) + 1):
            roll.append((closes_dated[i][0], _stdev_ann(rets[i - n:i], 252)))
        roll = [(d, v) for d, v in roll if v is not None]
        hist = [v for _, v in roll[-252:]]
        if len(hist) >= 40:
            s = sorted(hist)
            q = lambda p: s[int(p * (len(s) - 1))]  # noqa: E731
            cur = hist[-1]
            cones[str(n)] = {
                "min": round(s[0], 2), "p25": round(q(0.25), 2), "median": round(q(0.5), 2),
                "p75": round(q(0.75), 2), "max": round(s[-1], 2), "current": round(cur, 2),
                "pct": round(100.0 * sum(1 for v in hist if v <= cur) / len(hist), 1),
                "n": len(hist),
            }
        if n == 20:
            series = [{"d": d.isoformat(), "rv": round(v, 2)} for d, v in roll[-130:]]
    out["cone"] = cones
    out["series"] = series
    return out


def intraday_rv(candles: list[dict]) -> dict | None:
    """Today's realized vol from the latest session's 5-min bars, annualized as if
    every day looked like this one (75 bars x 252 days). None until there are
    enough bars to mean anything."""
    if not candles:
        return None
    cs = sorted(candles, key=lambda c: c["time"])
    last_day = datetime.fromtimestamp(cs[-1]["time"], IST).date()
    # Upstox answers a 5-min request with 1-min bars, so bucket to 5 min ourselves
    # (last close per bucket) -- the annualisation below assumes 5-min spacing.
    buckets: dict[int, float] = {}
    for c in cs:
        if c.get("close") and datetime.fromtimestamp(c["time"], IST).date() == last_day:
            buckets[int(c["time"]) // 300] = c["close"]
    rets = _log_returns([buckets[k] for k in sorted(buckets)])
    if len(rets) < 12:
        return None
    return {"rv": _r(_stdev_ann(rets, 75 * 252), 2), "bars": len(rets), "date": last_day.isoformat()}


async def realized_block(symbol: str) -> dict:
    hit = _RV_CACHE.get(symbol)
    if hit and time.time() - hit[0] < _RV_TTL:
        return hit[1]
    out: dict = {"available": False}
    try:
        daily, src = await candle_sources.underlying_candles(symbol, 86400)
        if daily:
            dated = _daily_closes(daily)
            if len(dated) >= 12:
                out = {"available": True, "source": src, **realized(dated),
                       "lastClose": dated[-1][1], "lastDate": dated[-1][0].isoformat()}
        intra, _ = await candle_sources.underlying_candles(symbol, 300)
        out["today"] = intraday_rv(intra or [])
    except Exception as exc:  # noqa: BLE001
        log.warning("realized vol %s failed: %s", symbol, exc)
        out.setdefault("error", str(exc))
    if out.get("available"):
        _RV_CACHE[symbol] = (time.time(), out)
    return out


def implied_vs_realized(term: list[dict], rv: dict) -> dict | None:
    iv30 = constant_maturity_iv(term, 30.0)
    rv20 = rv.get("rv20") if rv.get("available") else None
    if not iv30 or not rv20:
        return None
    ratio = iv30 / rv20
    if ratio >= 1.5:
        read = "IV is well above what the index has actually been moving"
    elif ratio >= 1.2:
        read = "IV carries a normal premium over recent movement"
    elif ratio >= 0.95:
        read = "IV is only slightly above recent movement"
    else:
        read = "IV is below recent movement - options are cheap against what the index has realised"
    return {"iv30": round(iv30, 2), "rv20": rv20, "spread": round(iv30 - rv20, 2),
            "ratio": round(ratio, 2), "read": read}


# ---------------------------------------------------------------- the plain-words summary
# Rules of thumb, deliberately simple and untuned. The first two are the cut-offs implied_vs_realized() already reads with.
EXPENSIVE_RATIO, CHEAP_RATIO = 1.5, 0.95      # 30-day IV / 20-day realized
QUIET_PCT, BUSY_PCT = 20.0, 80.0              # percentile of today's 20-day realized within the past year
FEAR_STRONG, FEAR_MILD, CHASE = -0.35, -0.10, 0.10   # 25-delta risk reversal as a fraction of ATM IV
INVERTED = 1.08                               # front-expiry ATM IV vs the 30-day IV (near richer / cheaper than a month out)
TODAY_HOT, TODAY_CALM = 1.2, 0.7              # today's realized vs the front ATM IV
TODAY_MIN_BARS = 24                           # 5-min returns needed before "today" means anything (2 hours)
NOTE = "How traders read these numbers - not a recommendation. Selling options can lose far more than you collect."


def summarize(symbol: str, spot: float, term: list[dict], iv30: float | None, rv: dict, vrp: dict | None) -> dict | None:
    """The Vol tab in a few plain sentences. Every piece is optional: a missing input drops its line instead of
    guessing. Returns None when there is nothing at all to say."""
    front = next((t for t in term if t.get("atmIV")), None)
    cone = (rv.get("cone") or {}).get("20") if rv.get("available") else None
    points: list[dict] = []

    # ---- 1. expensive or cheap? (what options charge vs what the market actually did)
    verdict = lean = None
    if vrp:
        ratio, iv, rv20 = vrp["ratio"], vrp["iv30"], vrp["rv20"]
        if ratio >= EXPENSIVE_RATIO:
            verdict, lean = "expensive", "sell"
            headline = (f"Options look EXPENSIVE: 30-day IV is {iv:.1f}% but only {rv20:.1f}% has actually been realized "
                        f"(x{ratio:.1f}). Traders lean toward SELLING premium, with defined risk (spreads).")
        elif ratio < CHEAP_RATIO:
            verdict, lean = "cheap", "buy"
            headline = (f"Options look CHEAP: 30-day IV is {iv:.1f}%, below the {rv20:.1f}% actually realized. "
                        f"Traders lean toward BUYING options.")
        else:
            verdict, lean = "fair", "none"
            headline = (f"Options look FAIRLY priced: 30-day IV is {iv:.1f}% against {rv20:.1f}% realized. "
                        f"Volatility gives no clear edge, so direction matters more.")
        # a ratio can look extreme only because the last 20 days were unusually quiet / busy
        if cone and verdict == "expensive" and cone["pct"] <= QUIET_PCT:
            points.append({"key": "caveat", "title": "Careful", "tone": "warn",
                           "text": f"The last 20 days were unusually quiet (quieter than {100 - cone['pct']:.0f}% of the past year), "
                                   f"which makes IV look high by comparison. Quiet spells can end abruptly."})
        elif cone and verdict == "cheap" and cone["pct"] >= BUSY_PCT:
            points.append({"key": "caveat", "title": "Careful", "tone": "warn",
                           "text": f"The last 20 days were unusually busy (busier than {cone['pct']:.0f}% of the past year), "
                                   f"which makes IV look low by comparison. Busy spells tend to calm down."})
    else:
        headline = "Can't tell whether options are cheap or expensive right now: realized volatility isn't available."

    # ---- 2. the range the market expects to expiry
    if front and front.get("sigmaMovePct") and spot:
        s = front["sigmaMovePct"]
        d = front.get("dte") or 0
        points.append({"key": "range", "title": "Expected range", "tone": "info",
                       "text": f"Until {front['expiry']} ({d:.0f} day{'' if round(d) == 1 else 's'}): {spot * (1 - s / 100):,.0f} to "
                               f"{spot * (1 + s / 100):,.0f} (±{s:.1f}%), about two times out of three. Sellers put strikes outside it; "
                               f"buyers need a bigger move than that."})

    # ---- 3. what is the market afraid of?
    if front and front.get("rr25") is not None and front.get("atmIV"):
        rr, rel = front["rr25"], front["rr25"] / front["atmIV"]
        if rel <= FEAR_STRONG:
            text = f"Puts are much pricier than calls (risk reversal {rr:+.1f}): the market is paying up for downside protection."
        elif rel <= FEAR_MILD:
            text = f"Puts are a little pricier than calls ({rr:+.1f}): the usual tilt, no unusual fear."
        elif rel >= CHASE:
            text = f"Calls are pricier than puts ({rr:+.1f}): the market is paying up for the upside."
        else:
            text = f"Puts and calls are priced about evenly ({rr:+.1f}): no strong lean either way."
        points.append({"key": "fear", "title": "What it fears", "tone": "info", "text": text})

    # ---- 4. is a near-term event priced in?
    if front and iv30 and front.get("dte") and 1 <= front["dte"] <= 25:
        r = front["atmIV"] / iv30
        if r >= INVERTED:
            points.append({"key": "term", "title": "Near-term event", "tone": "info",
                           "text": f"The nearest expiry ({front['expiry']}) is priced richer than a month out ({front['atmIV']:.1f}% vs "
                                   f"{iv30:.1f}%): the market expects something soon. IV often drops once it has passed."})
        elif r <= 1 / INVERTED:
            points.append({"key": "term", "title": "Near-term event", "tone": "info",
                           "text": f"The nearest expiry is cheaper than a month out ({front['atmIV']:.1f}% vs {iv30:.1f}%): "
                                   f"the normal, calm shape, with nothing big priced in soon."})

    # ---- 5. today against what is priced
    today = rv.get("today") if rv else None
    if front and today and today.get("rv") and today.get("bars", 0) >= TODAY_MIN_BARS and front.get("atmIV"):
        r = today["rv"] / front["atmIV"]
        if r >= TODAY_HOT:
            points.append({"key": "today", "title": "Today", "tone": "info",
                           "text": f"Moving faster than options are pricing ({today['rv']:.1f}% vs {front['atmIV']:.1f}%): good for buyers, bad for sellers."})
        elif r <= TODAY_CALM:
            points.append({"key": "today", "title": "Today", "tone": "info",
                           "text": f"Calmer than options are pricing ({today['rv']:.1f}% vs {front['atmIV']:.1f}%): good for sellers, slow for buyers."})

    # ---- 6. recent movement in context of the past year
    if cone:
        p = cone["pct"]
        word = "unusually busy" if p >= BUSY_PCT else "unusually quiet" if p <= QUIET_PCT else "about normal"
        points.append({"key": "context", "title": "Recent movement", "tone": "info",
                       "text": f"20-day realized is {cone['current']:.1f}%: {word} for the past year "
                               f"(higher than {p:.0f}% of it; the middle half was {cone['p25']:.1f}% to {cone['p75']:.1f}%)."})

    if verdict is None and not points:
        return None
    order = {"caveat": 0, "range": 1, "fear": 2, "term": 3, "today": 4, "context": 5}
    points.sort(key=lambda p: order.get(p["key"], 9))
    return {"verdict": verdict, "lean": lean, "headline": headline, "points": points, "note": NOTE}


# ---------------------------------------------------------------- chains
async def _chain(symbol: str, expiry: str, front: bool) -> tuple[dict | None, bool]:
    """(chain, stale). The front expiry is kept fresh by the poller; the others are
    re-fetched here when older than CHAIN_MAX_AGE, falling back to whatever is cached."""
    cached = store.get_chain(symbol, expiry)
    fa = store.fetched_at.get((symbol, expiry))
    if cached is not None and (front or (fa and time.time() - fa < CHAIN_MAX_AGE)):
        return cached, False
    try:
        from . import poller, upstox_data

        payload = None
        if poller._use_upstox(symbol):
            payload = await upstox_data.fetch_chain_payload(symbol, expiry)
        if not payload and not poller._is_bse_index(symbol):
            payload = await client.option_chain(symbol, expiry)
        if payload:
            store.put_raw(symbol, expiry, payload)
            fresh = store.get_chain(symbol, expiry)
            if fresh is not None:
                return fresh, False
    except Exception as exc:  # noqa: BLE001
        log.debug("vol chain %s %s failed: %s", symbol, expiry, exc)
    return cached, cached is not None


async def build(symbol: str, base_chain: dict, max_expiries: int = MAX_EXPIRIES) -> dict:
    symbol = symbol.upper()
    hit = _CACHE.get(symbol)
    if hit and time.time() - hit[0] < _TTL and hit[1].get("expiry") == base_chain["expiry"]:
        return hit[1]

    expiries = list(base_chain.get("expiries") or [base_chain["expiry"]])
    front = store.nearest_expiry(symbol) or expiries[0]
    rows: list[dict] = []
    skipped: list[str] = []
    for exp in expiries[:max_expiries + 2]:
        if len(rows) >= max_expiries:
            break
        ch = base_chain if exp == base_chain["expiry"] else None
        stale = False
        if ch is None:
            ch, stale = await _chain(symbol, exp, front=(exp == front))
        if ch is None or not ch.get("rows"):
            skipped.append(exp)
            continue
        item = expiry_summary(ch)
        item["smile"] = smile_points(ch)
        item["stale"] = stale
        rows.append(item)
        if item["dte"] >= TARGET_DAYS and len(rows) >= 3:
            break

    term = [{k: v for k, v in r.items() if k != "smile"} for r in rows]
    rv = await realized_block(symbol)
    iv30 = _r(constant_maturity_iv(term, 30.0), 2)
    vrp = implied_vs_realized(term, rv)
    try:
        summary = summarize(symbol, base_chain["spot"], term, iv30, rv, vrp)
    except Exception as exc:  # noqa: BLE001 - the summary is a nicety, never the reason the tab fails
        log.warning("vol summary %s failed: %s", symbol, exc)
        summary = None
    out = {
        "symbol": symbol,
        "spot": base_chain["spot"],
        "expiry": base_chain["expiry"],   # the chain this request was made for
        "asOf": time.time(),
        "expiries": rows,
        "term": term,
        "iv30": iv30,
        "iv7": _r(constant_maturity_iv(term, 7.0), 2),
        "rv": rv,
        "vrp": vrp,
        "summary": summary,
        "skipped": skipped,
    }
    _CACHE[symbol] = (time.time(), out)
    return out
