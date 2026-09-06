import { useEffect, useState } from "react";

/** true when the viewport is phone-sized. Drives the mobile app-shell in
 *  App.tsx; the desktop three-pane layout is untouched above the breakpoint. */
const QUERY = "(max-width: 820px)";

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
