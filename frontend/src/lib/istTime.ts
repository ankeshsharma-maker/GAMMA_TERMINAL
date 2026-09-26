/* lightweight-charts draws UTC by default, which shows the NSE session 09:15-15:30
 * about 5.5h off. These give its axis and crosshair Indian Standard Time. */
const IST = "Asia/Kolkata";

export const istTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export const istDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { timeZone: IST, day: "2-digit", month: "short" });

/** YYYY-MM-DD of the IST trading day a timestamp falls on (en-CA prints ISO order). */
export const istDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: IST });

export const IST_LOCALIZATION = {
  timeFormatter: (t: number) => `${istDate(t)} ${istTime(t)}`,
};

export const istTickFormatter = (t: number, tickType: number) =>
  tickType <= 2 ? istDate(t) : istTime(t);

export const IST_OFFSET_S = 19800; // UTC+5:30
const SESSION_OPEN_S = 9 * 3600 + 15 * 60; // 09:15 after IST midnight

export const WEEK_S = 604800; // the 1W chart interval: calendar weeks from Monday
export const MONTH_S = 2592000; // the 1M chart interval: calendar months (the number is only a label)

/** Start time of the candle containing `t` for a chart interval of `sec` seconds. Bars of 30 minutes up to (not
 *  including) a day are anchored to the 09:15 session open, like NSE charts (1h = 09:15, 10:15 ... 15:15); a daily
 *  bar sits on IST midnight of its date, a weekly one on its Monday, a monthly one on the 1st; shorter intervals
 *  use plain epoch alignment. MUST match `bucket_start` in backend/app/charting.py. */
export const bucketStart = (t: number, sec: number): number => {
  if (sec === WEEK_S) {
    const day = Math.floor((t + IST_OFFSET_S) / 86400); // day 0 (1 Jan 1970) was a Thursday
    return (day - ((day + 3) % 7)) * 86400 - IST_OFFSET_S;
  }
  if (sec === MONTH_S) {
    const d = new Date((t + IST_OFFSET_S) * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - IST_OFFSET_S;
  }
  if (sec === 86400) return Math.floor((t + IST_OFFSET_S) / 86400) * 86400 - IST_OFFSET_S;
  if (sec >= 1800 && sec < 86400) {
    const open = Math.floor((t + IST_OFFSET_S) / 86400) * 86400 - IST_OFFSET_S + SESSION_OPEN_S;
    return open + Math.floor((t - open) / sec) * sec;
  }
  return Math.floor(t / sec) * sec;
};
