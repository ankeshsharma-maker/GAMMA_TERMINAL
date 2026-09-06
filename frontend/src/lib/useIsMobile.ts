import { useEffect, useState } from "react";

/** true when the viewport is phone / folding-phone sized. Drives the mobile
 *  app-shell in App.tsx; the desktop three-pane layout is used above this.
 *  900px so a Galaxy Z Fold's unfolded inner screen (~820–840 CSS px) still
 *  gets the single-pane shell rather than a cramped three-pane. */
const QUERY = "(max-width: 900px)";

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => {
    try {
      return window.matchMedia(QUERY).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  return mobile;
}
