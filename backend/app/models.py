"""Request/response schemas for the API surface."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class WatchlistAdd(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=30)


class PaperOrderIn(BaseModel):
    symbol: str
    expiry: str
    strike: float
    option_type: Literal["CE", "PE"]
    side: Literal["BUY", "SELL"]
    qty_lots: int = Field(1, ge=1, le=500)
    price: Optional[float] = None  # None -> mark against latest LTP
    note: str = ""


class PaperOrderClose(BaseModel):
    position_id: str
    price: Optional[float] = None


class StopIn(BaseModel):
    position_id: str
    mode: Literal["points", "amount"] = "points"
    value: float = Field(0.0, ge=0)  # 0 = no stop-loss (target only)
    trail_value: float = Field(0.0, ge=0, alias="trailValue")
    target_value: float = Field(0.0, ge=0, alias="targetValue")

    model_config = {"populate_by_name": True}


class StrategyLeg(BaseModel):
    option_type: Literal["CE", "PE", "FUT"] = Field(..., alias="optionType")
    strike: float = 0.0
    side: Literal["BUY", "SELL"]
    lots: int = Field(1, ge=1, le=500)
    price: Optional[float] = None

    model_config = {"populate_by_name": True}

    def dump(self) -> dict:
        return {
            "optionType": self.option_type,
            "strike": self.strike,
            "side": self.side,
            "lots": self.lots,
            "price": self.price,
        }


class AnalyzeIn(BaseModel):
    symbol: str
    expiry: Optional[str] = None
    legs: list[StrategyLeg]
    price_range: float = Field(0.10, ge=0.02, le=0.5, alias="priceRange")
    points: int = Field(121, ge=41, le=401)

    model_config = {"populate_by_name": True}


class SaveStrategyIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    symbol: str
    expiry: str
    legs: list[StrategyLeg]


class OrderIn(BaseModel):
    symbol: str
    expiry: Optional[str] = None
    strike: float
    option_type: Literal["CE", "PE"] = Field(..., alias="optionType")
    side: Literal["BUY", "SELL"]
    qty_lots: int = Field(1, ge=1, le=500, alias="qtyLots")
    order_type: Literal["MKT", "LMT"] = Field("MKT", alias="orderType")
    price: Optional[float] = None
    product: Literal["NRML", "MIS"] = "NRML"
    mode: Optional[Literal["paper", "live"]] = None  # None -> server default

    model_config = {"populate_by_name": True}


class OrderModeIn(BaseModel):
    mode: Literal["paper", "live"]


class HedgeIn(BaseModel):
    symbol: str
    expiry: Optional[str] = None
    legs: list[StrategyLeg]
    max_loss: float = Field(..., gt=0, alias="maxLoss")
    max_lots: int = Field(1, ge=1, le=20, alias="maxLots")
    # optional extra targets/caps on the resulting (post-hedge) position —
    # all unset by default, i.e. no extra constraint.
    max_profit_cap: Optional[float] = Field(None, gt=0, alias="maxProfitCap")
    min_pop: Optional[float] = Field(None, ge=0, le=100, alias="minPop")
    max_abs_delta: Optional[float] = Field(None, ge=0, alias="maxAbsDelta")
    max_abs_theta: Optional[float] = Field(None, ge=0, alias="maxAbsTheta")
    max_abs_vega: Optional[float] = Field(None, ge=0, alias="maxAbsVega")
    max_abs_gamma: Optional[float] = Field(None, ge=0, alias="maxAbsGamma")
    max_hedge_iv: Optional[float] = Field(None, gt=0, alias="maxHedgeIv")

    model_config = {"populate_by_name": True}


class StrategyExecuteIn(BaseModel):
    symbol: str
    expiry: Optional[str] = None
    legs: list[StrategyLeg]
    order_type: Literal["MKT", "LMT"] = Field("MKT", alias="orderType")
    product: Literal["NRML", "MIS"] = "NRML"
    mode: Optional[Literal["paper", "live"]] = None

    model_config = {"populate_by_name": True}


class ScheduleIn(BaseModel):
    symbol: str
    expiry: str
    legs: list[StrategyLeg]
    entry_time: Optional[str] = Field(None, alias="entryTime")  # "HH:MM" IST
    exit_time: Optional[str] = Field(None, alias="exitTime")
    repeat: bool = False
    mode: Literal["paper", "live"] = "paper"
    note: str = ""

    model_config = {"populate_by_name": True}
