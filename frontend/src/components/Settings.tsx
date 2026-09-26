import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api, sessions, users, type ViewerUser } from "../lib/api";
import { disablePush, enablePush, getPushState, type PushState } from "../lib/push";
import { isViewer, lockNow, viewerName } from "../lib/auth";
import { FontScale } from "./FontScale";
import { SelectMenu } from "./SelectMenu";
import { openPinSetup, clearPin, hasPin } from "./PinLock";
import { useIsMobile } from "../lib/useIsMobile";
import {
  ACCENTS,
  GROUNDS,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP,
  getAccent,
  getGround,
  getUiZoom,
  setAccent,
  setGround,
  setUiZoom,
} from "../lib/theme";
import {
  getDefaultLots,
  setDefaultLots,
  getDefaultProduct,
  setDefaultProduct,
  getDataSrc,
  setDataSrc,
  getIntervalS,
  setIntervalS,
  getAutolockMin,
  setAutolockMin,
  getSoundEnabled,
  setSoundEnabled,
} from "../lib/prefs";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-term-border/60 px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-term-dim">
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
  stack = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /** controls on their own wrapping line under the label (many chips -- no sideways scroll on a phone) */
  stack?: boolean;
}) {
  if (stack)
    return (
      <div className="flex flex-col gap-1.5">
        <div className="min-w-0">
          <div className="text-xs text-term-text">{label}</div>
          {hint && <div className="text-[10px] leading-snug text-term-dim">{hint}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      </div>
    );
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-term-text">{label}</div>
        {hint && <div className="text-[10px] leading-snug text-term-dim">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

const SEG =
  "rounded border px-2 py-1 text-2xs font-semibold transition-colors";
const on = "border-term-accent bg-term-accent/15 text-term-text";
const off = "border-term-dim/70 text-term-dim hover:text-term-text";

/** Webhook / Telegram delivery for fired alerts -- everything that already
 *  lands in the in-app Alerts feed (broker-bracket hits, leg-rule fills, OI
 *  watches, unusual Greeks, schedules) goes out here too once enabled,
 *  no per-source setup needed. */
function AlertDeliverySection() {
  const [enabled, setEnabled] = useState(false);
  const [minSeverity, setMinSeverity] = useState<"info" | "warning" | "critical">("warning");
  const [autobotAlerts, setAutobotAlerts] = useState<"all" | "important" | "off">("all");
  const [greeksAlerts, setGreeksAlerts] = useState<"big" | "all" | "off">("big");
  // volume spikes: one setting, shared with the Volume tab's 🔔 (0 = off)
  const [volLevel, setVolLevel] = useState<number | null>(null);
  const [volMinCr, setVolMinCr] = useState<number>(5);
  const [alertSyms, setAlertSyms] = useState<string[]>([]);
  const [symInput, setSymInput] = useState("");
  const [webhookSet, setWebhookSet] = useState(false);
  const [telegramSet, setTelegramSet] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pushState, setPushState] = useState<PushState>({
    supported: false,
    permission: "default",
    subscribed: false,
  });
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const loadPush = () => getPushState().then(setPushState, () => {});
  useEffect(() => {
    loadPush();
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      if (pushState.subscribed) await disablePush();
      else await enablePush();
      await loadPush();
    } catch (e: any) {
      setPushMsg(String(e?.message || e));
    } finally {
      setPushBusy(false);
    }
  };

  const testPush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      const d = await api.pushTest();
      setPushMsg(`Sent to ${d.sent}/${d.total} device(s)`);
    } catch (e: any) {
      setPushMsg(String(e?.message || e));
    } finally {
      setPushBusy(false);
    }
  };

  const load = () =>
    api.alertDeliveryGet().then((d) => {
      setEnabled(d.enabled);
      setMinSeverity(d.minSeverity);
      setAutobotAlerts(d.autobotAlerts ?? "all");
      setGreeksAlerts(d.greeksAlerts ?? "big");
      setAlertSyms(d.symbols ?? []);
      setWebhookSet(d.webhookUrlSet);
      setTelegramSet(d.telegramSet);
    }, () => {});
  useEffect(() => {
    load();
    api.volumeScreenerConfigGet().then(
      (c) => {
        setVolLevel(c.alertLevel);
        setVolMinCr(c.minValueCr);
      },
      () => {}
    );
  }, []);
  const saveVol = (patch: { alertLevel?: number; minValueCr?: number }) =>
    api.volumeScreenerConfig(patch).then(
      (c) => {
        setVolLevel(c.alertLevel);
        setVolMinCr(c.minValueCr);
      },
      (e) => alert(String(e?.message || e))
    );

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const d = await api.alertDeliverySet(patch);
      setEnabled(d.enabled);
      setWebhookSet(d.webhookUrlSet);
      setTelegramSet(d.telegramSet);
    } catch (e: any) {
      setTestMsg(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTestMsg(null);
    setBusy(true);
    try {
      const d = await api.alertDeliveryTest();
      setTestMsg(
        `Sent to ${[d.webhook && "webhook", d.telegram && "Telegram"].filter(Boolean).join(" + ")}`
      );
    } catch (e: any) {
      setTestMsg(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (field: "webhookUrl" | "telegramBotToken" | "telegramChatId") => {
    const d = await api.alertDeliveryClear(field);
    setWebhookSet(d.webhookUrlSet);
    setTelegramSet(d.telegramSet);
  };

  return (
    <Section title="Alert delivery">
      <Row label="Send alerts out" hint="Webhook, Telegram and/or push, on top of the in-app feed">
        <button
          onClick={() => save({ enabled: !enabled })}
          className={`h-4 w-8 shrink-0 rounded-full transition-colors ${enabled ? "bg-up" : "bg-term-border ring-1 ring-inset ring-term-dim/60"} relative`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${enabled ? "left-4" : "left-0.5"}`}
          />
        </button>
      </Row>
      <Row label="Minimum severity">
        {(["info", "warning", "critical"] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setMinSeverity(s);
              save({ minSeverity: s });
            }}
            className={`${SEG} ${minSeverity === s ? on : off}`}
          >
            {s}
          </button>
        ))}
      </Row>

      <Row
        label="Auto-trading events"
        hint="Entries, exits, errors and safety stops from the Auto tab. They are info-level, so 'Minimum severity' would otherwise drop every entry and exit."
      >
        {(
          [
            ["all", "All"],
            ["important", "Exits, errors & stops"],
            ["off", "Off"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              setAutobotAlerts(k);
              save({ autobotAlerts: k });
            }}
            className={`${SEG} ${autobotAlerts === k ? on : off}`}
          >
            {label}
          </button>
        ))}
      </Row>

      <Row
        label="Market alerts for"
        stack
        hint="Gamma blast, OI surge, IV / straddle spikes, flow reversals, volume spikes and delta/gamma jumps only for the symbols picked here — none picked = every symbol. Alerts about your own positions (short-strike guard, SL / target) and alerts you set yourself always come through."
      >
        {[...new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", ...alertSyms])].map((s) => {
          const sel = alertSyms.includes(s);
          return (
            <button
              key={s}
              onClick={() => {
                const next = sel ? alertSyms.filter((x) => x !== s) : [...alertSyms, s];
                setAlertSyms(next);
                save({ symbols: next });
              }}
              className={`${SEG} ${sel ? on : off}`}
            >
              {s}
            </button>
          );
        })}
        <input
          value={symInput}
          onChange={(e) => setSymInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            const v = symInput.trim();
            if (e.key === "Enter" && v && !alertSyms.includes(v)) {
              const next = [...alertSyms, v];
              setAlertSyms(next);
              save({ symbols: next });
              setSymInput("");
            }
          }}
          placeholder="+ stock, Enter"
          className="w-28 rounded border border-term-border bg-term-bg px-2 py-1 text-2xs outline-none focus:border-term-accent"
        />
        <span className="text-2xs text-term-dim">
          {alertSyms.length ? `only ${alertSyms.join(", ")}` : "all symbols"}
        </span>
      </Row>

      <Row
        label="Delta / gamma jumps"
        hint="Sudden delta or gamma moves on single strikes. 'Very big only' sends just a quarter-delta jump or gamma x2.5 on a near-the-money strike of the nearest expiry, in market hours, at most one per symbol per 10 min. All of them still show in the app's Alerts feed."
      >
        {(
          [
            ["big", "Very big only"],
            ["all", "All"],
            ["off", "Off"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              setGreeksAlerts(k);
              save({ greeksAlerts: k });
            }}
            className={`${SEG} ${greeksAlerts === k ? on : off}`}
          >
            {label}
          </button>
        ))}
      </Row>

      <Row
        label="Volume spikes"
        hint="A stock trading this many times its usual volume for the time of day (Volume tab). Once per level per stock per day, not before 09:30, only when at least the minimum value has traded. Same setting as the 🔔 in the Volume tab."
      >
        {(
          [
            [0, "Off"],
            [2, "2x"],
            [3, "3x"],
            [5, "5x"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => saveVol({ alertLevel: k })} className={`${SEG} ${volLevel === k ? on : off}`}>
            {label}
          </button>
        ))}
      </Row>
      {volLevel !== 0 && volLevel != null && (
        <Row label="…with at least" hint="Rupee value traded today before a volume spike alerts — keeps thin stocks quiet.">
          {[1, 5, 25, 100].map((v) => (
            <button key={v} onClick={() => saveVol({ minValueCr: v })} className={`${SEG} ${volMinCr === v ? on : off}`}>
              ₹{v} Cr
            </button>
          ))}
        </Row>
      )}

      <div className="flex flex-col gap-1">
        <div className="text-xs text-term-text">Webhook URL</div>
        {webhookSet ? (
          <div className="flex items-center gap-1.5">
            <span className="flex-1 truncate rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-dim">
              configured — ●●●●●●●●
            </span>
            <button onClick={() => clear("webhookUrl")} className={`${SEG} ${off}`}>
              Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-endpoint.example.com/hook"
              className="w-full min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-text outline-none focus:border-term-accent"
            />
            <button
              disabled={!webhookUrl.trim() || busy}
              onClick={() => {
                save({ webhookUrl });
                setWebhookUrl("");
              }}
              className={`${SEG} ${off} disabled:opacity-40`}
            >
              Save
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-term-text">Telegram bot</div>
        <div className="text-[10px] leading-snug text-term-dim">
          Message <span className="text-term-text">@BotFather</span> on Telegram → /newbot for a
          token; message your new bot once, then open{" "}
          <span className="text-term-text">api.telegram.org/bot&lt;token&gt;/getUpdates</span> to
          find your chat id.
        </div>
        {telegramSet ? (
          <div className="flex items-center gap-1.5">
            <span className="flex-1 truncate rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-dim">
              configured — ●●●●●●●●
            </span>
            <button onClick={() => clear("telegramBotToken")} className={`${SEG} ${off}`}>
              Remove
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="bot token (from @BotFather)"
              className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-text outline-none focus:border-term-accent"
            />
            <div className="flex items-center gap-1.5">
              <input
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="chat id"
                className="w-full min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-text outline-none focus:border-term-accent"
              />
              <button
                disabled={!botToken.trim() || !chatId.trim() || busy}
                onClick={() => {
                  save({ telegramBotToken: botToken, telegramChatId: chatId });
                  setBotToken("");
                  setChatId("");
                }}
                className={`${SEG} ${off} disabled:opacity-40`}
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>

      <Row label="Send a test alert">
        <button disabled={busy || (!webhookSet && !telegramSet)} onClick={test} className={`${SEG} ${off} disabled:opacity-40`}>
          {busy ? "…" : "Test"}
        </button>
      </Row>
      {testMsg && <div className="text-[10px] text-term-dim">{testMsg}</div>}

      <div className="flex flex-col gap-1 border-t border-term-border/60 pt-3">
        <div className="text-xs text-term-text">Push notifications (this device)</div>
        <div className="text-[10px] leading-snug text-term-dim">
          A real notification even when the tab's closed. On iPhone this only works after adding
          GammaTerminal to the Home Screen (Share → Add to Home Screen) and opening it from there
          — a plain Safari tab can't subscribe.
        </div>
        {!pushState.supported ? (
          <span className="text-[10px] text-term-dim">Not supported in this browser.</span>
        ) : pushState.permission === "denied" ? (
          <span className="text-[10px] text-down">
            Blocked — allow notifications for this site in the browser's site settings.
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              disabled={pushBusy}
              onClick={togglePush}
              className={`${SEG} ${pushState.subscribed ? on : off} disabled:opacity-40`}
            >
              {pushBusy ? "…" : pushState.subscribed ? "Enabled ✓" : "Enable"}
            </button>
            {pushState.subscribed && (
              <button disabled={pushBusy} onClick={testPush} className={`${SEG} ${off} disabled:opacity-40`}>
                Test
              </button>
            )}
          </div>
        )}
        {pushMsg && <div className="text-[10px] text-term-dim">{pushMsg}</div>}
      </div>
    </Section>
  );
}

/** Paste-a-token path into Flattrade, for when the Connect Flattrade OAuth
 *  flow (header) isn't available. Hidden entirely if the backend has no
 *  FLATTRADE_* configured -- same gate BrokerPill uses. */
function BrokerTokenSection() {
  const broker = useStore((s) => s.broker);
  const setBrokerToken = useStore((s) => s.setBrokerToken);
  const [tok, setTok] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!broker || !broker.configured) return null;

  const submit = async () => {
    if (!tok.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await setBrokerToken(tok);
      setTok("");
      setMsg("Token set.");
    } catch (e: any) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Broker">
      <div className="flex flex-col gap-1">
        <div className="text-xs text-term-text">
          {broker.authed ? `Connected — ${broker.clientId}` : "Not connected"}
        </div>
        <div className="text-[10px] leading-snug text-term-dim">
          Normally handled by Connect Flattrade in the header — paste a token generated from
          the Flattrade portal directly if that flow isn't available
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={tok}
          onChange={(e) => setTok(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="paste Flattrade token"
          className="w-full min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-text outline-none focus:border-term-accent"
        />
        <button
          disabled={!tok.trim() || busy}
          onClick={submit}
          className={`${SEG} ${off} disabled:opacity-40`}
        >
          {busy ? "…" : "Set"}
        </button>
      </div>
      {msg && <div className="text-[10px] text-term-dim">{msg}</div>}
    </Section>
  );
}

/** The owner's view-only users (max 5): people who can open the terminal and see
 *  the market data, but not the owner's orders, positions, funds, trades,
 *  alerts or settings -- the server refuses all of that for them. They sign in
 *  with their name + password; each gets their own watchlists. */
function UsersSection() {
  const [list, setList] = useState<ViewerUser[] | null>(null);
  const [max, setMax] = useState(5);
  const [name, setName] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState("");

  const took = (d: { users: ViewerUser[]; max: number }) => {
    setList(d.users);
    setMax(d.max);
  };
  useEffect(() => {
    users.list().then(took, (e) => setMsg({ ok: false, text: String(e?.message || e) }));
  }, []);

  const run = async (fn: () => Promise<{ users: ViewerUser[]; max: number }>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      took(await fn());
      setMsg({ ok: true, text: done });
      return true;
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const n = name.trim();
    if (!n || !pwd) return;
    if (await run(() => users.add(n, pwd), `Added ${n}. They sign in with the name "${n}" and that password.`)) {
      setName("");
      setPwd("");
    }
  };
  const full = (list?.length ?? 0) >= max;
  const input =
    "min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 text-2xs text-term-text outline-none focus:border-term-accent";

  return (
    <Section title="View-only users">
      <div className="text-[10px] leading-snug text-term-dim">
        Up to {max} people who can see the market data (chain, OI, charts, flow, screener, Home) and build
        strategies to study — never your orders, positions, funds, trades, alerts or settings. They sign in
        with their name + password and get their own watchlists.
      </div>
      {list === null ? (
        <div className="text-2xs text-term-dim">loading…</div>
      ) : list.length === 0 ? (
        <div className="text-2xs text-term-dim">No viewers yet.</div>
      ) : (
        <table className="w-full text-2xs">
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="border-t border-term-border/40 align-top">
                <td className="py-1.5 pr-2">
                  <div className="font-semibold text-term-text">{u.name}</div>
                  <div className="text-[10px] text-term-dim">
                    added {u.created ? new Date(u.created * 1000).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "–"}
                  </div>
                  {resetId === u.id && (
                    <div className="mt-1 flex items-center gap-1">
                      <input
                        id={`reset-${u.id}`}
                        type="password"
                        autoComplete="new-password"
                        value={resetPwd}
                        onChange={(e) => setResetPwd(e.target.value)}
                        placeholder="new password (6+)"
                        className={input}
                      />
                      <button
                        disabled={busy || resetPwd.length < 6}
                        onClick={async () => {
                          if (await run(() => users.setPassword(u.id, resetPwd), `New password set for ${u.name} — their old sign-in stops working.`)) {
                            setResetId(null);
                            setResetPwd("");
                          }
                        }}
                        className={`${SEG} ${off} disabled:opacity-40`}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => {
                        setResetId(resetId === u.id ? null : u.id);
                        setResetPwd("");
                      }}
                      className={`${SEG} ${resetId === u.id ? on : off}`}
                    >
                      Password
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Remove ${u.name}? They are signed out at once and their watchlists are deleted.`))
                          run(() => users.remove(u.id), `Removed ${u.name}.`);
                      }}
                      className={`${SEG} border-term-border text-down hover:bg-down/10`}
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list !== null && !full && (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            id="viewer-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            autoComplete="off"
            className={input}
          />
          <input
            id="viewer-password"
            type="password"
            autoComplete="new-password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="password (6+)"
            className={input}
          />
          <button disabled={busy || !name.trim() || pwd.length < 6} onClick={add} className={`${SEG} ${off} disabled:opacity-40`}>
            {busy ? "…" : "Add"}
          </button>
        </div>
      )}
      {full && <div className="text-[10px] text-term-dim">All {max} places are used — remove one to add another.</div>}
      {msg && <div className={`text-[10px] ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</div>}
    </Section>
  );
}

/** let a mounted Chart adopt a changed default immediately */
const notifyPrefs = () => window.dispatchEvent(new Event("gt-prefs"));

export function Settings({ onClose }: { onClose: () => void }) {
  const orderMode = useStore((s) => s.orderMode);
  const isMobile = useIsMobile();
  const [, force] = useState(0);
  const redraw = () => force((n) => n + 1);

  const [lots, setLots] = useState(getDefaultLots());
  const [product, setProduct] = useState(getDefaultProduct());
  const [src, setSrc] = useState(getDataSrc());
  const [ivl, setIvl] = useState(getIntervalS());
  const [zoom, setZoom] = useState(getUiZoom());
  const [autolock, setAutolock] = useState(getAutolockMin());
  const [soundOn, setSoundOn] = useState(getSoundEnabled());
  const accent = getAccent();
  const ground = getGround();
  const pin = hasPin();

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-term-bg text-term-text"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div className="flex items-center justify-between border-b border-term-border bg-term-panel2 px-4 py-2.5">
        <span className="text-sm font-semibold">Settings</span>
        <button
          onClick={onClose}
          className="rounded border border-term-dim/70 px-2.5 py-1 text-2xs text-term-dim hover:text-term-text"
        >
          Done
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---- Appearance ---- */}
        <Section title="Appearance">
          <Row label="Text size" hint="Scales the whole interface">
            <FontScale />
          </Row>
          {!isMobile && (
            <Row label="Interface scale" hint="Shrink the whole desktop layout to fit more on screen">
              <div className="segx items-center text-2xs">
                <button
                  onClick={() => {
                    const z = Math.max(UI_ZOOM_MIN, zoom - UI_ZOOM_STEP);
                    setUiZoom(z);
                    setZoom(z);
                  }}
                  disabled={zoom <= UI_ZOOM_MIN}
                  className="px-1.5 py-1 text-term-dim hover:bg-term-border hover:text-term-text disabled:opacity-30"
                >
                  −
                </button>
                <button
                  onClick={() => {
                    setUiZoom(100);
                    setZoom(100);
                  }}
                  title="Reset interface scale"
                  className="border-x border-term-border px-1.5 py-1 text-[10px] text-term-dim hover:bg-term-border hover:text-term-text"
                >
                  {zoom}%
                </button>
                <button
                  onClick={() => {
                    const z = Math.min(UI_ZOOM_MAX, zoom + UI_ZOOM_STEP);
                    setUiZoom(z);
                    setZoom(z);
                  }}
                  disabled={zoom >= UI_ZOOM_MAX}
                  className="px-1.5 py-1 font-semibold text-term-dim hover:bg-term-border hover:text-term-text disabled:opacity-30"
                >
                  +
                </button>
              </div>
            </Row>
          )}
          <Row label="Accent colour">
            <div className="flex max-w-[220px] flex-wrap justify-end gap-1.5">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  title={a.label}
                  onClick={() => {
                    setAccent(a.id);
                    redraw();
                  }}
                  className={`h-6 w-6 rounded-full border-2 ${
                    accent === a.id ? "border-term-text" : "border-transparent"
                  }`}
                  style={{ background: `rgb(${a.rgb})` }}
                />
              ))}
            </div>
          </Row>
          <Row label="Background">
            <div className="flex max-w-[240px] flex-wrap justify-end gap-1.5">
              {GROUNDS.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setGround(g.id);
                    redraw();
                  }}
                  className={`${SEG} ${ground === g.id ? on : off}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        {isViewer() && (
          <Section title="Account">
            <Row label={viewerName() ?? "Viewer"} hint="View-only: market data only — trading, positions, funds and alerts setup are off">
              <span className={`${SEG} border-term-accent/50 text-term-accent`}>VIEW ONLY</span>
            </Row>
          </Section>
        )}

        {/* ---- Security ---- */}
        <Section title="Security">
          <Row
            label={pin ? "Device passcode" : "Set a passcode"}
            hint="Stays on this device. Independent of the app password."
          >
            <button onClick={openPinSetup} className={`${SEG} ${off}`}>
              {pin ? "Change" : "Set"}
            </button>
            {pin && (
              <button
                onClick={() => {
                  if (confirm("Remove the device passcode?")) {
                    clearPin();
                    redraw();
                  }
                }}
                className={`${SEG} border-term-dim/70 text-term-dim hover:border-down hover:text-down`}
              >
                Remove
              </button>
            )}
          </Row>
          <Row label="Auto-lock" hint="Re-ask the passcode after this long in the background">
            {[
              [0, "Off"],
              [1, "1m"],
              [5, "5m"],
              [15, "15m"],
            ].map(([v, l]) => (
              <button
                key={v}
                onClick={() => {
                  setAutolockMin(v as number);
                  setAutolock(v as number);
                }}
                className={`${SEG} ${autolock === v ? on : off}`}
              >
                {l}
              </button>
            ))}
          </Row>
          {!isViewer() && (
            <Row
              label="Sign out all devices"
              hint="Every phone, browser and viewer — this one too — must enter the password again. Your broker connection stays."
            >
              <button
                onClick={async () => {
                  if (!confirm("Sign out GammaTerminal on EVERY device, including this one? Everyone must enter the password again.")) return;
                  try {
                    await sessions.logoutAll();
                  } catch (e: any) {
                    alert(`Couldn't sign out everywhere: ${e?.message || e}`);
                    return;
                  }
                  lockNow();
                }}
                className={`${SEG} border-term-border text-down hover:bg-down/10`}
              >
                Sign out all
              </button>
            </Row>
          )}
          <Row label="Sign out" hint="Clears the session; the app password will be asked again">
            <button
              onClick={() => {
                if (confirm("Sign out of GammaTerminal on this device?")) lockNow();
              }}
              className={`${SEG} border-term-border text-down hover:bg-down/10`}
            >
              Sign out
            </button>
          </Row>
        </Section>

        {!isViewer() && <UsersSection />}

        {/* ---- Trading defaults ---- */}
        {!isViewer() && (
        <Section title="Trading defaults">
          <Row label="Default lots" hint="Pre-fills the quantity in Scalp / Builder / rules">
            <button
              onClick={() => {
                const n = Math.max(1, lots - 1);
                setLots(n);
                setDefaultLots(n);
              }}
              className={`${SEG} ${off}`}
            >
              −
            </button>
            <span className="num w-6 text-center text-xs">{lots}</span>
            <button
              onClick={() => {
                const n = Math.min(999, lots + 1);
                setLots(n);
                setDefaultLots(n);
              }}
              className={`${SEG} ${off}`}
            >
              +
            </button>
          </Row>
          <Row label="Default product">
            {(["NRML", "MIS"] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setDefaultProduct(p);
                  setProduct(p);
                }}
                className={`${SEG} ${product === p ? on : off}`}
              >
                {p}
              </button>
            ))}
          </Row>
          <Row label="Order mode" hint="Change from the header / drawer">
            <span
              className={`${SEG} ${
                orderMode === "live" ? "border-down text-down" : "border-term-dim/70 text-term-dim"
              }`}
            >
              {orderMode === "live" ? "LIVE" : "PAPER"}
            </span>
          </Row>
          <Row label="Order sound" hint="Tone on manual order placement and AutoBot entries/exits">
            {(["on", "off"] as const).map((k) => (
              <button
                key={k}
                onClick={() => {
                  const v = k === "on";
                  setSoundEnabled(v);
                  setSoundOn(v);
                }}
                className={`${SEG} ${(k === "on") === soundOn ? on : off}`}
              >
                {k === "on" ? "On" : "Muted"}
              </button>
            ))}
          </Row>
        </Section>
        )}

        {!isViewer() && <BrokerTokenSection />}

        {/* ---- Data ---- */}
        <Section title="Data">
          <Row label="Default candle source">
            <SelectMenu
              value={src}
              options={
                [
                  ["Auto", "auto"],
                  ["Flattrade", "broker"],
                  ["Upstox", "upstox"],
                ] as const
              }
              onChange={(v) => {
                setDataSrc(v);
                setSrc(v);
                notifyPrefs();
              }}
              width={120}
              align="right"
            />
          </Row>
          <Row label="Default candle interval">
            <SelectMenu
              value={ivl}
              options={
                [
                  ["15s", 15],
                  ["1m", 60],
                  ["3m", 180],
                  ["5m", 300],
                  ["15m", 900],
                  ["1h", 3600],
                  ["1D", 86400],
                ] as const
              }
              onChange={(v) => {
                setIntervalS(v);
                setIvl(v);
                notifyPrefs();
              }}
              width={90}
              align="right"
            />
          </Row>
        </Section>

        {!isViewer() && <AlertDeliverySection />}

        {/* ---- About ---- */}
        <Section title="About">
          <Row label="Build">
            <span className="num text-[10px] text-term-dim">{__APP_BUILD__}</span>
          </Row>
          <Row label="Backend">
            <span className="num text-[10px] text-term-dim">
              {import.meta.env.VITE_API_BASE || location.origin}
            </span>
          </Row>
          <Row label="Reload the app">
            <button onClick={() => location.reload()} className={`${SEG} ${off}`}>
              Reload
            </button>
          </Row>
          <Row label="Clear local data" hint="Watchlists, layout, theme, passcode — on this device only">
            <button
              onClick={() => {
                if (confirm("Clear ALL local data on this device? Watchlists, layout, theme and passcode will be reset.")) {
                  try {
                    localStorage.clear();
                  } catch {
                    /* ignore */
                  }
                  location.reload();
                }
              }}
              className={`${SEG} border-term-border text-down hover:bg-down/10`}
            >
              Clear
            </button>
          </Row>
        </Section>

        <div className="h-8" />
      </div>
    </div>
  );
}
