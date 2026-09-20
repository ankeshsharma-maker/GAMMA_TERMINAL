"""CRUD + control endpoints for the indicator/OI auto-trading engine."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import autobot_structures as ST
from .autobot import autobot

router = APIRouter(prefix="/api/autobot")


@router.get("")
def get_autobot():
    return autobot.snapshot()


@router.post("/master")
def set_master(body: dict):
    return autobot.set_master(bool((body or {}).get("on")))


@router.post("/max-loss")
def set_max_loss(body: dict):
    return autobot.set_max_loss(float((body or {}).get("value", 0) or 0))


@router.post("/rules")
def upsert_rule(body: dict):
    if not (body or {}).get("symbol"):
        raise HTTPException(status_code=400, detail="rule needs a symbol")
    return autobot.upsert_rule(body)


@router.post("/rules/{rid}/enabled")
def set_enabled(rid: str, body: dict):
    return autobot.set_rule_enabled(rid, bool((body or {}).get("on")))


@router.delete("/rules/{rid}")
def delete_rule(rid: str):
    return autobot.delete_rule(rid)


@router.post("/rules/{rid}/resume")
def resume(rid: str):
    """Lift a safety pause (losing streak / rule loss cap) for the rest of today."""
    return autobot.resume_rule(rid)


@router.get("/stats")
def stats(limit: int = 60):
    """Performance of every rule from the closed-trade ledger, net of estimated charges."""
    return autobot.stats(max(1, min(int(limit), 500)))


@router.get("/structures")
def structures():
    """The multi-leg structures a rule can trade, with their default strike offset / width."""
    return {"structures": ST.catalog()}


@router.get("/structure-preview")
async def structure_preview(
    symbol: str, structure: str, offset: int | None = None, width: int | None = None,
    expiry: str | None = None,
):
    """The concrete legs a structure would open right now, their prices, the net premium and
    the payoff limits per lot -- so a rule can be checked before it is saved."""
    from .routes import _ensure_chain

    if structure not in ST.STRUCTURES:
        raise HTTPException(status_code=422, detail=f"unknown structure {structure!r}")
    chain = await _ensure_chain(symbol, expiry)
    k, w = ST.clamp_params(structure, offset, width)
    legs = ST.legs_for(structure, chain["atmStrike"], chain["strikeStep"], k, w)
    rows = {r["strike"]: r for r in chain["rows"]}
    prices = []
    for lg in legs:
        r = rows.get(lg["strike"])
        leg = (r or {}).get("call" if lg["ot"] == "CE" else "put") or {}
        bid, ask = float(leg.get("bid") or 0), float(leg.get("ask") or 0)
        prices.append(float(leg.get("ltp") or 0) or ((bid + ask) / 2 if bid and ask else 0.0))
    out_legs = [{**lg, "price": round(p, 2), "inChain": lg["strike"] in rows} for lg, p in zip(legs, prices)]
    net = ST.net_premium(legs, prices)
    pay = ST.payoff_limits(legs, prices)
    ls = chain.get("lotSize", 1)
    return {
        "symbol": chain["symbol"], "expiry": chain["expiry"], "atmStrike": chain["atmStrike"],
        "strikeStep": chain["strikeStep"], "lotSize": ls, "dte": chain.get("dte"),
        "params": {"offset": k, "width": w}, "legs": out_legs, "label": ST.label(structure, legs),
        "net": round(net, 2), "kind": "DEBIT" if net > 0 else "CREDIT",
        "perLot": round(abs(net) * ls, 0),
        "maxProfit": None if pay["maxProfit"] is None else round(pay["maxProfit"] * ls, 0),
        "maxLoss": None if pay["maxLoss"] is None else round(pay["maxLoss"] * ls, 0),
        "missing": [lg["strike"] for lg in out_legs if not lg["inChain"]],
    }


@router.post("/kill")
def kill():
    return autobot.kill()


@router.post("/backtest")
async def backtest(body: dict):
    """Backtest of a rule over [from, to] ('YYYY-MM-DD').
    body: {rule:{...}}  OR  {ruleId:"..."} to use a saved rule, + from,to, optional interval/bars
    and costs {enabled, slippagePct, brokerage} (on by default)."""
    from .autobot_backtest import backtest_rule

    rule = body.get("rule")
    if not rule and body.get("ruleId"):
        rule = next((r for r in autobot.rules if r.get("id") == body["ruleId"]), None)
    if not rule:
        raise HTTPException(400, "rule or ruleId required")
    frm, to = body.get("from"), body.get("to")
    if not frm or not to:
        raise HTTPException(400, "from and to required")
    try:
        interval = int(body.get("interval") or 86400)
    except (TypeError, ValueError):
        interval = 86400
    try:
        bars = int(body.get("bars") or 0)
    except (TypeError, ValueError):
        bars = 0
    try:
        return await backtest_rule(rule, frm, to, interval, bars, body.get("costs"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"backtest failed: {exc}")
