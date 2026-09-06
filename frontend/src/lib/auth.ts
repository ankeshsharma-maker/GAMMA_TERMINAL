// Single-password gate for the whole app. The token is an opaque string the
// backend hands back after /api/auth/login; we attach it to every request and
// the WebSocket. When the backend has no APP_PASSWORD set, `required` is false
// and none of this does anything.

const KEY = "gt.appToken";

let _token: string | null = readToken();
const listeners = new Set<() => void>();

function readToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
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
