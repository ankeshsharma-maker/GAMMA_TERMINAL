# GammaTerminal

A retail options-analytics terminal for Indian index/stock options (NIFTY, BANKNIFTY, FINNIFTY, stocks).
Built to track expiry-day **gamma blast** setups: live option chain, per-strike Greeks, OI shifts,
PCR/IV, watchlist, 1-click **paper** trading, and (roadmap) scanner + strategy builder + charts.

> Data source: public NSE option-chain endpoints. No broker wiring yet — 1-click buy/sell is **paper only**.
> Real-time tick data and live orders require a broker API (Dhan/Kite/Fyers) — see Roadmap.

## Stack

| Layer     | Tech                                                         |
|-----------|-------------------------------------------------------------|
| Backend   | Python 3.10+, FastAPI, httpx, asyncio poller               |
| Greeks    | Hand-rolled Black-Scholes-Merton (no scipy), IV via Newton + bisection |
| Frontend  | React + Vite + TypeScript + Tailwind + Zustand              |
| Transport | REST for snapshots/CRUD, WebSocket for live chain pushes    |

## Quick start

### 1. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows PowerShell:  .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py                     # serves on http://localhost:8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                       # http://localhost:5173  (proxies /api and /ws to :8000)
```

Open http://localhost:5173.

## How it works

- `poller.py` refreshes the raw NSE option chain for every active symbol
  (defaults + watchlist + whatever a client subscribes to) every `POLL_INTERVAL` seconds
  (15s in market hours, 60s off-hours), using a bootstrapped browser session with cookie refresh + retry.
- For each request the raw snapshot is turned into a processed chain: ATM detection, per-strike
  implied vol solved from the bid/ask mid (falls back to NSE's IV), then full Greeks.
- Processed chains are cached per `(symbol, expiry, fetchedAt)` so switching expiries is instant.
- The WebSocket broadcasts a fresh processed chain to each client on every poll for the
  `(symbol, expiry)` it is watching.
- Paper orders/positions live in `data/paper.json`; MTM is marked against the latest snapshot LTP.

## Config

Copy `backend/.env.example` to `backend/.env` and override:

| Var                     | Default                       | Meaning                                  |
|-------------------------|-------------------------------|------------------------------------------|
| `RISK_FREE_RATE`        | `0.065`                       | r used in Black-Scholes                  |
| `DIVIDEND_YIELD`        | `0.0`                         | q used in Black-Scholes                  |
| `POLL_INTERVAL`         | `15`                          | seconds between polls in market hours    |
| `OFFHOURS_POLL_INTERVAL`| `60`                          | seconds between polls outside 09:15-15:30 IST |
| `DEFAULT_SYMBOLS`       | `NIFTY,BANKNIFTY,FINNIFTY`    | always-on symbols                        |
| `STRIKE_WINDOW`         | `20`                          | strikes each side of ATM to emit         |

## Slice 2 — Gamma-blast scanner (done)

`backend/app/scanner.py` scores every tracked symbol each poll from the current chain +
`store.history` deque:

| Sub-score   | What it measures                                                    |
|-------------|--------------------------------------------------------------------|
| `dte`       | expiry-day ramp — near zero beyond ~2 DTE, gates the whole score   |
| `gamma`     | ATM gamma×OI vs its own recent peak; bonus when dealers net short  |
| `breakout`  | 5-min spot move relative to the prior 20-min range (compression→expansion) |
| `straddle`  | ATM straddle % change over 5 min (expansion = blast, collapse = pin) |
| `ivpop`     | sudden ATM IV uptick over 5 min                                    |
| `unwind`    | one-sided CE/PE OI change (short covering / squeeze)               |
| `pin`       | spot distance from max pain                                        |

Composite **Gamma Blast Score** (0–100) = weighted blend × DTE gate, plus a directional
**bias** and human-readable **reasons**. Alerts fire (deduped, 5-min window) on score crossing
60/80, IV pop ≥ 2 pts/5m, or straddle expansion ≥ 20%/5m.

Endpoints: `GET /api/scan`, `GET /api/scan/{symbol}` (+ metric series for sparklines),
`GET /api/alerts`. WS pushes `scan` and `alerts` messages every cycle.
Frontend: header **Chain / Scanner** toggle + 🔔 alert bell, sortable scanner table
(click a row → its chain), live **Alert Feed**.

> Cold-start note: the `gamma` sub-score reads ~1.0 until ~20 min of history exists
> (no peak to normalise against yet). Scores stabilise after the deque fills.

## Slice 3 — Live charts (done)

`backend/app/charting.py` builds chart-ready series entirely from data we already
collect — no dependency on a candle feed:

- **Spot candles** — 1-min OHLC aggregated from the spot samples in `store.history`
  (persisted to `data/history/<symbol>.json` every 20 samples, reloaded on boot).
- **NSE intraday backfill** — on startup the poller best-effort pulls today's index
  tick series (`/api/chart-databyindex`) and seeds spot history; silently no-ops
  outside market hours.
- **Overlays** — synthetic **ATM straddle** line and **Gamma Blast Score** line
  (`store.scan_history`), each on its own price scale.

Endpoint: `GET /api/chart/{symbol}?interval=60`.
Frontend `Chart.tsx` uses **lightweight-charts v4**: candles + EMA 9 / EMA 21 /
Bollinger(20,2) (computed in `src/lib/indicators.ts`), 1m / 3m / 5m re-sampling,
per-series toggles, 15s auto-refresh, and a live last-price nudge from the chain feed.

> Like the scanner, the chart is thin until history accumulates (~15s per sample);
> it's most useful during market hours.

## Slice 4 — Strategy builder (done)

`backend/app/strategy.py`:

- **`analyze(chain, legs)`** — resolves each leg's entry price / IV / Greeks from the live
  chain, then computes the **payoff at expiry** and the **T+0 theoretical curve** over spot
  ±10%, plus net premium (debit/credit), max profit / max loss (with unbounded flags),
  breakevens (de-duped), **POP** (lognormal terminal distribution at ATM IV),
  risk:reward, **combined position Greeks**, and a **margin estimate**
  (debit for longs · max-loss for defined-risk · ~12%-notional heuristic for naked shorts —
  *not* SPAN).
- **11 prebuilt templates** (straddle/strangle, vertical spreads, iron condor/fly, butterfly,
  ratio backspread) anchored to ATM ± strike-step.
- **Save / load** named strategies (`data/strategies.json`); **build from paper positions**.

Endpoints: `POST /api/strategy/analyze`, `GET /api/strategy/templates`,
`POST /api/strategy/from-paper`, `GET|POST /api/strategies`, `DELETE /api/strategies/{id}`.

Frontend: header **Builder** view — leg editor (type / strike / side / lots, per-leg entry &
IV shown), template picker, expiry selector, save/load list, and a hand-rolled SVG
**payoff diagram** (`PayoffChart.tsx`: expiry vs T+0 curves, P/L shading, spot & breakeven
markers) with a metrics + Greeks strip.

## Slice 5 — Cross-symbol screener (done)

A **second background task** (`poller.run_universe_scan`) walks `FO_UNIVERSE` (~130 indices +
liquid F&O stocks, configurable via `SCREENER_SYMBOLS`), pulling the nearest **non-expired**
expiry chain per symbol on a gentle stagger (`SCREENER_STAGGER`, 2.5s in market hours →
~5 min/full cycle; 4× slower off-hours). It does not touch `store.raw`/`history` — it writes
a screener row to `store.universe` and pushes ATM IV to `store.iv_history`.

`backend/app/screener.py` computes per symbol: session move %, PCR, ATM IV,
**session IV rank / percentile** (over IV history collected this session — meaningful after a
few hours), ATM straddle as % of spot, max-pain distance, net GEX, and an **OI-buildup
classification** (long/short buildup, short covering, long unwinding from price move × ΣOI change).

Endpoints: `GET /api/screener` (rows + progress + presets), `GET /api/screener/{symbol}`
(row + IV series). WS pushes `screener` messages as the scan advances.

Frontend: the Scanner view now has a **Gamma Blast | Screener** sub-tab. Screener =
filter bar (IV-rank / PCR / ATM-IV / DTE / move% / straddle% min-max + OI-buildup chips),
**8 presets** (High/Low IV, Long/Short Buildup, Short Covering, Near expiry, Bullish/Bearish PCR),
sortable columns, live progress, click-through to the chain.

> IV rank is session-based until it has hours of data. A true rank needs a historical IV feed.

## Slice 6A — Flattrade broker: data (done)

`backend/app/brokers/flattrade.py` — Noren / Pi Connect adapter: OAuth-style login,
day-scoped session cached in `data/broker_session.json`, REST (`Limits`, `PositionBook`,
`OrderBook`, `Holdings`, `SearchScrip`, `GetQuotes`, `TPSeries`) and a reconnecting
WebSocket touchline feed. `PlaceOrder` etc. are wired in Slice 6B.

- **Real-time spot** — `broker_feed.run_broker_feed` streams underlying ticks over the
  broker WS and fans them out as `tick` messages; the header, watchlist and chart show the
  live price (falls back to the NSE poll when the feed is cold).
- **Real candles** — `/api/chart/{symbol}` pulls `TPSeries` 1-min bars for the underlying
  when the broker is connected (`candleSource: "broker"`), instead of the sampled history.
- Endpoints: `GET /api/broker/status|login|callback|logout`, `GET /api/broker/funds|positions|orders|holdings`.
- Frontend: header **Connect Flattrade** button → status pill (`FT · <clientId>` + feed dot),
  live price in header/watchlist, funds line in the Positions panel.

### Connecting Flattrade

1. Create an API app at <https://wall.flattrade.in> (Pi → API Key). Set its **Redirect URL** to
   `http://127.0.0.1:8000/api/broker/callback`.
2. Put `FLATTRADE_API_KEY`, `FLATTRADE_API_SECRET`, `FLATTRADE_CLIENT_ID` in `backend/.env`
   (see `.env.example`) and restart the backend.
3. Click **Connect Flattrade** in the header → log in in the new tab → it redirects back and
   caches the session for the trading day. The pill turns green.

Credentials live only in `backend/.env`; the session token only in `data/broker_session.json`
(both gitignored). Nothing broker-related leaves your machine except calls to Flattrade.

## Slice 6B — live orders (done)

Unified order routing (`POST /api/order`, `POST /api/strategy/execute`) that goes to the
paper book or to Flattrade depending on a persisted **order mode**:

- `GET|POST /api/order/mode` — switching to `live` is refused unless Flattrade is connected.
- `strategy.resolve_nfo(name, expiry, strike, type)` builds the Noren trading symbol
  (`NIFTY08SEP26C24050`) and confirms it via `SearchScrip`; `PlaceOrder` only needs
  `exch + tsym`, so an unconfirmed symbol still routes.
- Every routed live order is logged (`/api/order/live-log`) with `PLACED` / `REJECTED` +
  the broker's reason.

Frontend:
- Header **PAPER / LIVE** segmented toggle. LIVE turns the header border red; the switch
  needs a connected broker and a `confirm()`.
- `OrderConfirm.tsx` — a modal shown before **every** live order (single or multi-leg):
  contract list, side, lots, qty, est. debit/credit, explicit "real money" warning.
- 1-click B/S, the order ticket, and the strategy builder's **Execute** button all route
  through the same path; in PAPER they fire immediately, in LIVE they open the confirm modal.
- Positions panel gains a **Live Orders** section (status + rejection reasons).

> The live `PlaceOrder` call itself can only be exercised with your Flattrade session — the
> paper path, the mode guard, and the resolver are covered by tests.

## Unusual Greeks activity (done)

`store._detect_greek_moves` compares each near-ATM strike's per-poll **delta** and **gamma**
against the previous snapshot. It fires an event when |Δdelta| ≥ `GREEK_DELTA_JUMP` (0.12) or
gamma moves ≥ `GREEK_GAMMA_JUMP_PCT` (60%), tagged `DELTA_JUMP` / `GAMMA_SPIKE` / `GAMMA_COLLAPSE`
(dedup 150s, only strikes within `GREEK_NEAR_ATM_STRIKES` of ATM).

- Events land in `store.unusual`; the processed chain carries `hotGreeks` for strikes hot in the
  last `GREEK_EVENT_TTL` (180s).
- WS pushes a `unusual` message; `GET /api/unusual` for the list.
- Header 🔔 opens a **Notification panel** with two tabs — **Unusual Activity** and **Alerts** —
  with an unseen badge on the bell.
- The **Greeks** tab rings the affected Δ / Γ cell (`!` / `▲` / `▼`) and tints the row amber.

## Roadmap (next slices)

1. **Alert delivery** — browser notifications + webhook/Telegram out.
2. **Strategy what-if** — date/vol/spot sliders on the payoff.
3. **RSI / MACD panes**, drawing tools, OI-profile histogram beside the chart.
4. **Per-strike live overlay** — subscribe option-leg tokens on the broker feed so the whole
   chain ticks in real time, not just the underlying.
5. **Order management** — modify/cancel from the Live Orders panel; positions square-off via broker.
