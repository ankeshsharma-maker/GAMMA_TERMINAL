import { useEffect, useState } from "react";
import { useStore } from "../store";
import { playRejectSound } from "../lib/soundNotif";

type Rej = { ts: number; orderId: string; message: string; reason: string };

/** A red banner the moment Flattrade rejects an order (pushed by the server's order watcher), so it is
 *  not discovered later in the broker app's order history. Stays until dismissed; tap it for the orders. */
export function OrderRejectedToast() {
  const [items, setItems] = useState<Rej[]>([]);
  const setView = useStore((s) => s.setView);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Rej>).detail;
      if (!d) return;
      setItems((xs) => (xs.some((x) => x.orderId && x.orderId === d.orderId) ? xs : [d, ...xs].slice(0, 5)));
      playRejectSound();
    };
    window.addEventListener("gt-order-rejected", on);
    return () => window.removeEventListener("gt-order-rejected", on);
  }, []);
  if (!items.length) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-2 z-[80] flex flex-col items-center gap-2 px-2"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {items.map((it) => (
        <div
          key={it.orderId || it.ts}
          className="pointer-events-auto flex w-full max-w-lg items-start gap-3 rounded-lg border-2 border-down bg-red-950/95 px-3 py-2.5 text-white shadow-2xl"
        >
          <span className="mt-0.5 text-lg leading-none">⛔</span>
          <button
            className="flex-1 text-left"
            onClick={() => {
              setView("orders");
              setItems((xs) => xs.filter((x) => x !== it));
            }}
            title="Open the order book"
          >
            <div className="text-[13px] font-bold leading-snug">{it.message}</div>
            <div className="mt-0.5 text-[11px] opacity-80">Not placed at the exchange · tap to open Orders</div>
          </button>
          <button
            aria-label="Dismiss"
            className="rounded px-1.5 text-lg leading-none opacity-80 hover:opacity-100"
            onClick={() => setItems((xs) => xs.filter((x) => x !== it))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
