// Single-password gate for the whole app. The token is an opaque string the
// backend hands back after /api/auth/login; we attach it to every request and
// the WebSocket. When the backend has no APP_PASSWORD set, `required` is false
// and none of this does anything.

const KEY = "gt.appToken";
const ROLE_KEY = "gt.appRole";

let _token: string | null = readToken();
const listeners = new Set<() => void>();

function readToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// ---- who is signed in: the owner, or one of the (up to 5) view-only users.
// The server decides what a viewer may reach (everything account-related is
// 403 for them); the app just hides what they can't use. Set by LoginGate
// from /api/auth/status before anything else renders.
export type Role = "owner" | "viewer";
let _role: { role: Role; name: string | null } = readRole();

function readRole(): { role: Role; name: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(ROLE_KEY) || "null");
    if (v && v.role === "viewer") return { role: "viewer", name: v.name ?? null };
  } catch {
    /* ignore */
  }
  return { role: "owner", name: null };
}

export function setRole(role: Role | null | undefined, name?: string | null): void {
  _role = { role: role === "viewer" ? "viewer" : "owner", name: role === "viewer" ? name ?? null : null };
  try {
    if (_role.role === "viewer") localStorage.setItem(ROLE_KEY, JSON.stringify(_role));
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    /* ignore */
  }
}

/** a view-only user: market data yes, the owner's orders / positions / funds / trades no */
export function isViewer(): boolean {
  return _role.role === "viewer";
}

export function viewerName(): string | null {
  return _role.name;
}

export function getToken(): string | null {
  return _token;
}

export function setToken(t: string | null): void {
  _token = t || null;
  try {
    if (_token) localStorage.setItem(KEY, _token);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** called by api.j() when a request comes back 401 */
export function handleUnauthorized(): void {
  if (_token) setToken(null);
}

/** user-initiated: drop the app token and reload — the PIN (if set) re-locks
 *  and the password gate reappears (when the backend requires one). */
export function lockNow(): void {
  setToken(null);
  try {
    location.reload();
  } catch {
    /* ignore */
  }
}
