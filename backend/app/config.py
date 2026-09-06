"""Runtime configuration, sourced from environment / .env."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR.parent / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

RISK_FREE_RATE = float(os.getenv("RISK_FREE_RATE", "0.065"))
DIVIDEND_YIELD = float(os.getenv("DIVIDEND_YIELD", "0.0"))

POLL_INTERVAL = float(os.getenv("POLL_INTERVAL", "15"))
OFFHOURS_POLL_INTERVAL = float(os.getenv("OFFHOURS_POLL_INTERVAL", "60"))

# Notional starting capital for paper trading (used for the Margin Available readout).
PAPER_CAPITAL = float(os.getenv("PAPER_CAPITAL", "500000"))
# Rough SPAN+exposure margin for a short option leg, as a fraction of strike notional.
SHORT_OPTION_MARGIN_PCT = float(os.getenv("SHORT_OPTION_MARGIN_PCT", "0.11"))

DEFAULT_SYMBOLS = [
    s.strip().upper()
    for s in os.getenv("DEFAULT_SYMBOLS", "NIFTY,BANKNIFTY,FINNIFTY").split(",")
    if s.strip()
]

# Strikes each side of ATM to compute Greeks for and emit (UI can show fewer: 10/20/30).
STRIKE_WINDOW = int(os.getenv("STRIKE_WINDOW", "30"))

# NSE index option-chain symbols (everything else is treated as an equity).
INDEX_SYMBOLS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"}

# Rolling history depth per symbol for the (future) gamma-blast scanner.
HISTORY_MAXLEN = int(os.getenv("HISTORY_MAXLEN", "720"))  # ~3h at 15s cadence

# ---- unusual Greeks activity detection ------------------------------
# Fires an "Unusual Activity" event when a near-ATM strike's per-poll
# delta / gamma move exceeds these, and highlights it in the Greeks tab.
GREEK_DELTA_JUMP = float(os.getenv("GREEK_DELTA_JUMP", "0.12"))       # abs delta change / poll
GREEK_GAMMA_JUMP_PCT = float(os.getenv("GREEK_GAMMA_JUMP_PCT", "0.6"))  # relative gamma change
GREEK_NEAR_ATM_STRIKES = int(os.getenv("GREEK_NEAR_ATM_STRIKES", "12"))
GREEK_EVENT_TTL = int(os.getenv("GREEK_EVENT_TTL", "180"))            # seconds a strike stays "hot"

# ---- cross-symbol screener --------------------------------------------
# Seconds between deep-scan option-chain fetches (gentle on NSE, runs alongside
# the fast poller). ~90 symbols * 2.5s ~= 4 min per full cycle.
SCREENER_STAGGER = float(os.getenv("SCREENER_STAGGER", "2.5"))
SCREENER_IV_HISTORY_MAXLEN = int(os.getenv("SCREENER_IV_HISTORY_MAXLEN", "1500"))

_DEFAULT_UNIVERSE = (
    # indices
    "NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,NIFTYNXT50,"
    # liquid F&O stocks
    "RELIANCE,HDFCBANK,ICICIBANK,INFY,TCS,SBIN,AXISBANK,KOTAKBANK,LT,ITC,"
    "BHARTIARTL,BAJFINANCE,BAJAJFINSV,HINDUNILVR,MARUTI,HCLTECH,SUNPHARMA,"
    "TATASTEEL,TATAMOTORS,ADANIENT,ADANIPORTS,ASIANPAINT,TITAN,ULTRACEMCO,"
    "WIPRO,NTPC,POWERGRID,ONGC,COALINDIA,GRASIM,JSWSTEEL,NESTLEIND,"
    "TECHM,HDFCLIFE,SBILIFE,DIVISLAB,DRREDDY,CIPLA,BRITANNIA,EICHERMOT,"
    "HEROMOTOCO,BAJAJ-AUTO,INDUSINDBK,APOLLOHOSP,HINDALCO,BPCL,IOC,"
    "DLF,GODREJCP,PIDILITIND,DABUR,MARICO,HAVELLS,SIEMENS,BEL,BHEL,"
    "CANBK,PNB,BANKBARODA,IDFCFIRSTB,FEDERALBNK,AUBANK,BANDHANBNK,"
    "LTIM,PERSISTENT,COFORGE,MPHASIS,OFSS,"
    "VEDL,NATIONALUM,SAIL,JINDALSTEL,APOLLOTYRE,BALKRISIND,MOTHERSON,"
    "TVSMOTOR,ASHOKLEY,BOSCHLTD,ABB,CUMMINSIND,POLYCAB,"
    "GAIL,PETRONET,IGL,GUJGASLTD,TORNTPHARM,LUPIN,AUROPHARMA,BIOCON,"
    "ZYDUSLIFE,ALKEM,LAURUSLABS,GLENMARK,TRENT,INDHOTEL,JUBLFOOD,"
    "PAGEIND,COLPAL,UBL,PVRINOX,NAUKRI,INDIGO,IRCTC,CONCOR,"
    "ADANIGREEN,TATAPOWER,TATACONSUM,PIIND,SRF,DEEPAKNTR,AARTIIND,"
    "MUTHOOTFIN,CHOLAFIN,LICHSGFIN,PFC,RECLTD,M&M,ICICIPRULI,ICICIGI,"
    "HDFCAMC,SBICARD,BAJAJHLDNG,DMART,NMDC,HINDPETRO,IEX,MCX"
)
FO_UNIVERSE = [
    s.strip().upper()
    for s in os.getenv("SCREENER_SYMBOLS", _DEFAULT_UNIVERSE).split(",")
    if s.strip()
]

# ---- broker (Flattrade / Noren Pi Connect) ---------------------------
BROKER = os.getenv("BROKER", "flattrade").lower()

# ---- market-data source -------------------------------------------------
# "nse" (default, the public NSE scrape) or "upstox" (REST /option/chain,
# also covers BSE/BFO -> SENSEX & BANKEX). Orders always stay on BROKER.
DATA_SOURCE = os.getenv("DATA_SOURCE", "nse").lower()
# Simplest: a 1-year Upstox "Analytics Access Token" (read-only, market-data).
# If set, the OAuth flow below is skipped entirely.
UPSTOX_ACCESS_TOKEN = os.getenv("UPSTOX_ACCESS_TOKEN", "")
# Only needed for the interactive daily-login OAuth path (not the analytics token).
UPSTOX_API_KEY = os.getenv("UPSTOX_API_KEY", "")
UPSTOX_API_SECRET = os.getenv("UPSTOX_API_SECRET", "")
UPSTOX_REDIRECT_URL = os.getenv(
    "UPSTOX_REDIRECT_URL", "http://127.0.0.1:8000/api/upstox/callback"
)
FLATTRADE_API_KEY = os.getenv("FLATTRADE_API_KEY", "")
FLATTRADE_API_SECRET = os.getenv("FLATTRADE_API_SECRET", "")
FLATTRADE_CLIENT_ID = os.getenv("FLATTRADE_CLIENT_ID", "").upper()
FLATTRADE_REDIRECT_URL = os.getenv(
    "FLATTRADE_REDIRECT_URL", "http://127.0.0.1:8000/api/broker/callback"
)

# Well-known NSE index tokens for the Flattrade/Noren feed (exch|token).
INDEX_FEED_TOKENS = {
    "NIFTY": ("NSE", "26000"),
    "BANKNIFTY": ("NSE", "26009"),
    "FINNIFTY": ("NSE", "26037"),
    "MIDCPNIFTY": ("NSE", "26074"),
    "NIFTYNXT50": ("NSE", "26013"),
}
