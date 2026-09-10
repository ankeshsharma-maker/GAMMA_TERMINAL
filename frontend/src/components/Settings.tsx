import { useState } from "react";
import { useStore } from "../store";
import { lockNow } from "../lib/auth";
import { FontScale } from "./FontScale";
import { SelectMenu } from "./SelectMenu";
import { openPinSetup, clearPin, hasPin } from "./PinLock";
import { useIsMobile } from "../lib/useIsMobile";
import {
  ACCENTS,
  GROUNDS,
  UI_ZOOMS,
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

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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
const off = "border-term-border text-term-dim hover:text-term-text";

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
  const accent = getAccent();
  const ground = getGround();
  const pin = hasPin();

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-term-bg text-term-text">
      <div className="flex items-center justify-between border-b border-term-border bg-term-panel2 px-4 py-2.5">
        <span className="text-sm font-semibold">Settings</span>
        <button
          onClick={onClose}
          className="rounded border border-term-border px-2.5 py-1 text-2xs text-term-dim hover:text-term-text"
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
              {UI_ZOOMS.map((z) => (
                <button
                  key={z}
                  onClick={() => {
                    setUiZoom(z);
                    setZoom(z);
                  }}
                  className={`${SEG} ${zoom === z ? on : off}`}
                >
                  {z}%
                </button>
              ))}
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
                className={`${SEG} border-term-border text-term-dim hover:border-down hover:text-down`}
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

        {/* ---- Trading defaults ---- */}
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
                orderMode === "live" ? "border-down text-down" : "border-term-border text-term-dim"
              }`}
            >
              {orderMode === "live" ? "LIVE" : "PAPER"}
            </span>
          </Row>
        </Section>

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
