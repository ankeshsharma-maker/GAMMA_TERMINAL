import { useEffect, useState } from "react";
import { auth } from "../lib/api";
import { getToken, setToken, onAuthChange } from "../lib/auth";

type Phase = "checking" | "login" | "ok";

/** Wraps the whole app. When the backend has APP_PASSWORD set, nothing renders
 *  until the right password is entered once (token is then kept on the device). */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    try {
      const s = await auth.status();
      if (!s.required || s.ok) setPhase("ok");
      else setPhase("login");
    } catch {
      // backend unreachable — let the app load; its own error states show
      setPhase("ok");
    }
  };

  useEffect(() => {
    check();
    return onAuthChange(() => {
      // token was cleared (e.g. a 401) — re-check
      if (!getToken()) check();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwd || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await auth.login(pwd);
      setToken(r.token);
      setPwd("");
      setPhase("ok");
    } catch (x: any) {
      setErr(x?.message === "Wrong password" ? "Wrong password" : "Login failed — check the connection");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "ok") return <>{children}</>;

  return (
    <div className="flex h-full items-center justify-center bg-term-bg p-6 text-term-text">
      {phase === "checking" ? (
        <span className="text-sm text-term-dim">…</span>
      ) : (
        <form
          onSubmit={submit}
          className="w-full max-w-xs rounded-lg border border-term-border bg-term-panel p-5"
        >
          <div className="mb-1 text-lg font-bold tracking-tight">GammaTerminal</div>
          <div className="mb-4 text-xs text-term-dim">Enter the app password to continue.</div>
          <input
            type="password"
            autoFocus
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="password"
            className="w-full rounded border border-term-border bg-term-bg px-3 py-2 text-sm outline-none focus:border-term-accent"
          />
          {err && <div className="mt-2 text-xs text-down">{err}</div>}
          <button
            type="submit"
            disabled={busy || !pwd}
            className="btn btn-buy mt-3 w-full py-2 font-semibold disabled:opacity-40"
          >
            {busy ? "…" : "Unlock"}
          </button>
        </form>
      )}
    </div>
  );
}
