"""Mixed AND / OR condition lists ("these 2 with AND, the other 3 with OR").

A rule's Entry / Exit list is FLAT. Historically one switch (`entryLogic` / `exitLogic`, "all" | "any") said whether every
condition or just one of them had to hold. To combine (A and B) with (C or D or E) a rule may now also carry, per side:

    entryGroups     [{"logic": "all"}, {"logic": "any"}]   one entry per group, in order (absent / empty = classic)
    entryLogic      "all" | "any"                          classic: the logic of the whole list
                                                           grouped: how the GROUPS combine (all = every group must hold,
                                                           any = one group is enough)
    entry[i]["grp"] 0, 1, ...                              the group condition i sits in (missing / bad -> group 0)

The list itself stays flat on purpose: everything that only scans the conditions (backtest capability checks, the
prev-candle readout, the per-condition "why" chips, which are index-aligned) keeps working untouched.

Rules saved before this have no `entryGroups`, so they evaluate exactly as they always did. A group with no conditions is
ignored (it neither blocks nor triggers); a list with no conditions at all is never true.
"""
from __future__ import annotations

from typing import Callable

ALL, ANY = "all", "any"
SIDES = ("entry", "exit")
MAX_GROUPS = 6
_DEFAULT_LOGIC = {"entry": ALL, "exit": ANY}


def _logic(v, default: str) -> str:
    return v if v in (ALL, ANY) else default


def group_logics(rule: dict, side: str) -> list[str] | None:
    """The logic ('all' | 'any') of each group of `side`, or None for a classic flat list."""
    raw = (rule or {}).get(f"{side}Groups")
    if not isinstance(raw, list) or not raw:
        return None
    return [_logic(g.get("logic") if isinstance(g, dict) else None, ALL) for g in raw[:MAX_GROUPS]]


def spec(rule: dict, side: str) -> tuple[str, list[str] | None]:
    """(logic, groups) for `side`: the classic whole-list logic with groups None, or the join between the groups."""
    return _logic((rule or {}).get(f"{side}Logic"), _DEFAULT_LOGIC[side]), group_logics(rule, side)


def group_of(cond, n: int) -> int:
    """The group index a condition sits in; anything missing, non-numeric or out of range means group 0."""
    try:
        g = int((cond or {}).get("grp", 0))
    except (TypeError, ValueError, AttributeError):
        return 0
    return g if 0 <= g < n else 0


def evaluate(conds: list, groups: list[str] | None, logic: str, at: Callable[[int], bool]) -> bool:
    """Is the list satisfied? `at(i)` is the truth of condition i, asked lazily so a decided list stops early."""
    n = len(conds or [])
    if not n:
        return False
    if not groups:
        return any(at(i) for i in range(n)) if logic == ANY else all(at(i) for i in range(n))
    members: list[list[int]] = [[] for _ in groups]
    for i, c in enumerate(conds):
        members[group_of(c, len(groups))].append(i)

    def holds(k: int) -> bool:
        return any(at(i) for i in members[k]) if groups[k] == ANY else all(at(i) for i in members[k])

    live = [k for k, ms in enumerate(members) if ms]
    return any(holds(k) for k in live) if logic == ANY else all(holds(k) for k in live)


def why_fields(conds: list, groups: list[str] | None) -> dict:
    """Extra keys for a rule's "why" record so the UI can draw the chips inside their groups."""
    if not groups:
        return {}
    return {"groups": list(groups), "grp": [group_of(c, len(groups)) for c in (conds or [])]}


def normalize(rule: dict) -> dict:
    """Tidy the group fields of a rule being saved, in place: a malformed `*Groups` falls back to the classic flat
    list (dropping the stray `grp` tags) instead of silently changing what the rule means."""
    for side in SIDES:
        key, conds = f"{side}Groups", rule.get(side)
        raw = rule.get(key)
        ok = isinstance(raw, list) and 0 < len(raw) <= MAX_GROUPS and all(isinstance(g, dict) for g in raw)
        if not ok:
            rule.pop(key, None)
            for c in conds if isinstance(conds, list) else []:
                if isinstance(c, dict):
                    c.pop("grp", None)
            continue
        rule[key] = [{"logic": _logic(g.get("logic"), ALL)} for g in raw]
        for c in conds if isinstance(conds, list) else []:
            if isinstance(c, dict):
                c["grp"] = group_of(c, len(raw))
    return rule
