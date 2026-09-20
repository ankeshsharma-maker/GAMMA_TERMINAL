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
