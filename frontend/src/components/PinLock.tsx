import { useEffect, useRef, useState } from "react";

// Device-local PIN — protects the app (and the stored login token) if someone
// picks up the phone. Independent of the backend password. The PIN never
// leaves the device; only its SHA-256 hash is kept in localStorage.

const HASH_KEY = "gt.pinHash";
const SEEN_KEY = "gt.pinPrompted";
const RELOCK_AFTER_MS = 60_000;

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const readHash = () => {
  try {
    return localStorage.getItem(HASH_KEY);
  } catch {
    return null;
  }
};

export function PinLock({ children }: { children: React.ReactNode }) {
  const hasPin = !!readHash();
  // locked at start only if a PIN exists
  const [locked, setLocked] = useState(hasPin);
  // show the one-time "set a PIN?" offer if none is set and we haven't asked
  const [offer, setOffer] = useState(() => {
    try {
      return !hasPin && !localStorage.getItem(SEEN_KEY);
    } catch {
      return false;
    }
  });
  const hiddenAt = useRef<number | null>(null);

  // re-lock when the app has been in the background for a while
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        hiddenAt.current = Date.now();
      } else if (
        readHash() &&
        hiddenAt.current &&
        Date.now() - hiddenAt.current > RELOCK_AFTER_MS
      ) {
        setLocked(true);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  if (offer) return <SetPin onDone={() => setOffer(false)} skippable />;
  if (locked) return <EnterPin onOk={() => setLocked(false)} />;
  return <>{children}</>;
}

function Keypad({ value, onKey }: { value: string; onKey: (k: string) => void }) {
  return (
    <div className="mt-4">
      <div className="mb-4 flex justify-center gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`h-3 w-3 rounded-full border ${
              i < value.length ? "border-term-accent bg-term-accent" : "border-term-border"
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k, i) =>
          k === "" ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              onClick={() => onKey(k)}
              className="rounded-lg border border-term-border bg-term-bg py-3 text-lg font-semibold hover:bg-term-border"
            >
              {k}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function SetPin({ onDone, skippable }: { onDone: () => void; skippable?: boolean }) {
  const [step, setStep] = useState<"first" | "confirm">("first");
  const [first, setFirst] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const key = (k: string) => {
    setErr(null);
    setPin((p) => {
      if (k === "⌫") return p.slice(0, -1);
      if (p.length >= 6) return p;
      const next = p + k;
      if (next.length >= 4 && next.length === 6) queueMicrotask(() => advance(next));
      return next;
    });
  };
  const advance = async (val: string) => {
    if (step === "first") {
      setFirst(val);
      setPin("");
      setStep("confirm");
    } else {
      if (val !== first) {
        setErr("PINs didn't match");
        setPin("");
        setStep("first");
        setFirst("");
        return;
      }
      try {
        localStorage.setItem(HASH_KEY, await sha(val));
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* ignore */
      }
      onDone();
    }
  };

  return (
    <Shell title={step === "first" ? "Set an app PIN" : "Re-enter the PIN"} sub="4–6 digits · stored only on this device">
      <Keypad value={pin} onKey={key} />
      <div className="mt-3 flex justify-between text-xs">
        <button
          onClick={() => pin.length >= 4 && advance(pin)}
          className="text-term-accent disabled:opacity-30"
          disabled={pin.length < 4}
        >
          OK
        </button>
        {skippable && step === "first" && (
          <button
            onClick={() => {
              try {
                localStorage.setItem(SEEN_KEY, "1");
              } catch {
                /* ignore */
              }
              onDone();
            }}
            className="text-term-dim hover:text-term-text"
          >
            Skip
          </button>
        )}
      </div>
      {err && <div className="mt-2 text-center text-xs text-down">{err}</div>}
    </Shell>
  );
}

function EnterPin({ onOk }: { onOk: () => void }) {
  const [pin, setPin] = useState("");
  const [tries, setTries] = useState(0);
  const [until, setUntil] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const locked = Date.now() < until;

  const key = (k: string) => {
    if (locked) return;
    setErr(null);
    setPin((p) => {
      if (k === "⌫") return p.slice(0, -1);
      if (p.length >= 6) return p;
      const next = p + k;
      if (next.length >= 4) queueMicrotask(() => tryPin(next));
      return next;
    });
  };
  const tryPin = async (val: string) => {
    if ((await sha(val)) === readHash()) {
      onOk();
      return;
    }
    setPin("");
    const t = tries + 1;
    setTries(t);
    if (t >= 3) {
      setUntil(Date.now() + 30_000);
      setTries(0);
      setErr("Too many tries — locked for 30s");
    } else {
      setErr("Wrong PIN");
    }
  };

  return (
    <Shell title="Enter PIN" sub={locked ? "locked — wait 30 seconds" : "unlock GammaTerminal"}>
      <Keypad value={pin} onKey={key} />
      {err && <div className="mt-2 text-center text-xs text-down">{err}</div>}
      <button
        onClick={() => {
          if (window.confirm("Reset the PIN? You'll also be signed out and need the app password again.")) {
            try {
              localStorage.removeItem(HASH_KEY);
              localStorage.removeItem("gt.appToken");
            } catch {
              /* ignore */
            }
            location.reload();
          }
        }}
        className="mt-3 w-full text-center text-[11px] text-term-dim hover:text-term-text"
      >
        Forgot PIN?
      </button>
    </Shell>
  );
}

function Shell({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-term-bg p-6 text-term-text">
      <div className="w-full max-w-[260px] rounded-lg border border-term-border bg-term-panel p-5">
        <div className="text-base font-bold tracking-tight">{title}</div>
        <div className="text-xs text-term-dim">{sub}</div>
        {children}
      </div>
    </div>
  );
}
