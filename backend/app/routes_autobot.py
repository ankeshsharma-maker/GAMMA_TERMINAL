"""CRUD + control endpoints for the indicator/OI auto-trading engine."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

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


@router.post("/kill")
def kill():
    return autobot.kill()


@router.post("/backtest")
async def backtest(body: dict):
    """Daily-bar backtest of a rule over [from, to] ('YYYY-MM-DD').
    body: {rule:{...}}  OR  {ruleId:"..."} to use a saved rule, + from,to."""
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
        return await backtest_rule(rule, frm, to)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"backtest failed: {exc}")
