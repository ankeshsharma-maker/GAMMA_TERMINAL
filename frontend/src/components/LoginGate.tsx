import { useEffect, useState } from "react";
import { auth } from "../lib/api";
import { getToken, setToken, setRole, onAuthChange } from "../lib/auth";
import { LogoWordmark } from "./Logo";

type Phase = "checking" | "login" | "ok";

/** Wraps the whole app. When the backend has APP_PASSWORD set, nothing renders
 *  until the right password is entered once (token is then kept on the device).
 *  The owner types the password alone; a view-only user types their name too. */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [pwd, setPwd] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    try {
      const s = await auth.status();
      if (!s.required || s.ok) {
        setRole(s.role ?? "owner", s.name);
        setPhase("ok");
      } else setPhase("login");
    } catch {
      // can't verify the gate — fail CLOSED. Only let through someone who
      // already holds a session token (returning user during a backend blip);
      // a fresh visitor sees the password screen.
      setPhase(getToken() ? "ok" : "login");
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
      const r = await auth.login(pwd, name.trim() || undefined);
      setRole(r.role ?? "owner", r.name);
      setToken(r.token);
      setPwd("");
      setPhase("ok");
    } catch (x: any) {
      const m = x?.message;
      setErr(m === "Wrong password" || m === "Wrong name or password" ? m : "Login failed — check the connection");
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
          className="w-full max-w-sm rounded-xl border border-term-border bg-term-panel p-7"
        >
          <div className="mb-4 scale-125 origin-left">
            <LogoWordmark mark={30} />
          </div>
          <div className="mb-6 text-sm text-term-dim">Enter the app password to continue.</div>
          <input
            id="login-name"
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (view-only users)"
            className="mb-2 w-full rounded-lg border border-term-border bg-term-bg px-4 py-3 text-base outline-none focus:border-term-accent"
          />
          <input
            id="login-password"
            type="password"
            autoFocus
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="password"
            className="w-full rounded-lg border border-term-border bg-term-bg px-4 py-3 text-base outline-none focus:border-term-accent"
          />
          {err && <div className="mt-2 text-sm text-down">{err}</div>}
          <button
            type="submit"
            disabled={busy || !pwd}
            className="btn btn-buy mt-4 w-full py-3 text-base font-semibold disabled:opacity-40"
          >
            {busy ? "…" : "Unlock"}
          </button>
        </form>
      )}
    </div>
  );
}
