"""One simulated position for the backtester, stepped bar by bar.

It makes the same decisions as the live engine (`autobot.AutoBot._manage`) because it
asks the same question of the same code (`autobot_exit`). What a backtest adds is the
time INSIDE a bar, which live never has to guess because it watches every tick.

A bar is described by its close and, optionally, the premium at its open, low and high.
With those, the bar is walked as a path of ticks in the standard neutral order:

    open -> the extreme NEARER the open -> the farther extreme -> close

(the same convention charting platforms use to resolve a bar's unknowable internal
order). Each point is judged exactly like a live tick, so a stop that is touched exits,
a trail tightens as new highs are made and can then be hit on the way back down, and a
gap past a stop fills at the open. Resting orders -- the stop, the scale-out and the
target -- fill at their own price when the path crosses them, not at wherever the bar
closed; the close only decides exit signals and the square-off.

With no extremes given it is a single tick at the close, filled at the close: exactly
what the live engine does once per poll, which is what the parity test relies on.
"""
from __future__ import annotations

from . import autobot_exit as X


class SimPosition:
    def __init__(self, rule: dict, *, buy: bool, base: float, lots: int, lot_size: int):
        self.rule = rule
        self.buy = buy
        self.base = base or 1.0
        self.lots = int(lots)
        self.entry_lots = int(lots)
        self.lot_size = int(lot_size) or 1
        self.peak = self.base
        self.partial_done = False
        self.closed = False
        self.realized = 0.0          # gross P&L already booked by a scale-out
        self.fills: list[tuple[int, float]] = []   # (lots, exit premium) of every closing fill

    # ---- helpers --------------------------------------------------------- #
    @property
    def qty(self) -> int:
        return max(1, self.lots * self.lot_size)

    def pnl(self, lots: int, px: float) -> float:
        return (px - self.base) * (1 if self.buy else -1) * lots * self.lot_size

    def _ev(self, ltp: float) -> X.ExitEval:
        return X.evaluate(self.rule, buy=self.buy, base=self.base, ltp=ltp, peak=self.peak, qty=self.qty)

    def _book_partial(self, lots: int, px: float, events: list[dict]) -> None:
        self.realized += self.pnl(lots, px)
        self.fills.append((lots, px))
        self.lots -= lots
        self.partial_done = True
        events.append({"kind": "partial", "lots": lots, "px": px, "reason": "scale-out"})

    def _exit(self, px: float, reason: str, events: list[dict]) -> list[dict]:
        self.fills.append((self.lots, px))
        events.append({"kind": "exit", "lots": self.lots, "px": px, "reason": reason,
                       "gross": self.realized + self.pnl(self.lots, px)})
        self.closed = True
        return events

    def _partial_due(self, ev: X.ExitEval) -> int:
        return X.partial_close_lots(self.rule, ev, entry_lots=self.entry_lots, lots=self.lots,
                                    done=self.partial_done)

    def _level(self, key: str) -> float:
        return X.fav_to_px(self.rule, self.rule.get(key), base=self.base, qty=self.qty, buy=self.buy)

    # ---- one bar --------------------------------------------------------- #
    def step(self, px: float, *, lo: float | None = None, hi: float | None = None,
             opn: float | None = None, exit_signal: bool = False, square_off: bool = False,
             kill: bool = False) -> list[dict]:
        """Advance one bar and return what happened, in order:
        {"kind": "partial"|"exit", "lots", "px", "reason", ("gross" on exit)}."""
        events: list[dict] = []
        rule, buy = self.rule, self.buy
        bars = lo is not None and hi is not None
        if bars:
            o = px if opn is None else opn
            first, second = (hi, lo) if abs(hi - o) < abs(o - lo) else (lo, hi)
            path = [o, first, second, px]
        else:
            path = [px]

        for i, p in enumerate(path):
            gap = bars and i == 0     # the open: a level already passed here fills at the open itself
            ev = self._ev(p)
            self.peak = round(ev.peak, 2)

            n = self._partial_due(ev)
            if n:
                if not bars:          # live books the scale-out and stops there for the tick
                    self._book_partial(n, p, events)
                    return events
                lvl = self._level("target1Pct")
                self._book_partial(n, max(lvl, p) if buy and gap else min(lvl, p) if gap else lvl, events)
                ev = self._ev(p)

            if X.stop_hit(ev):
                fill = p
                if bars and not gap:
                    fill = ev.stop_px                    # a resting stop fills at its own price
                elif bars:
                    fill = min(ev.stop_px, p) if buy else max(ev.stop_px, p)
                return self._exit(fill, X.stop_reason(rule, ev), events)
            if X.target_hit(rule, ev):
                fill = p
                if bars:
                    lvl = self._level("targetPct")
                    fill = (max(lvl, p) if buy else min(lvl, p)) if gap else lvl
                return self._exit(fill, X.target_reason(rule, ev), events)

        # the close, once the path has run its course
        if kill:
            return self._exit(px, "kill", events)
        if square_off:
            return self._exit(px, "square-off", events)
        if exit_signal:
            return self._exit(px, "exit signal", events)
        return events

    def force_close(self, px: float, reason: str = "range end") -> list[dict]:
        return self._exit(px, reason, [])
