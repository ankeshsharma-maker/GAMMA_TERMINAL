/** Sound notifications for order execution. Uses Web Audio API to generate tones. */
import { getSoundEnabled } from "./prefs";

// Buy: ascending tone (high energy)
function playBuySound() {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const now = ctx.currentTime;
  const duration = 0.3;

  // Ascending two-note sequence for buy
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  const gain2 = ctx.createGain();

  osc1.frequency.setValueAtTime(800, now);
  osc2.frequency.setValueAtTime(1200, now);

  osc1.connect(gain1);
  osc2.connect(gain2);
  gain1.connect(ctx.destination);
  gain2.connect(ctx.destination);

  gain1.gain.setValueAtTime(0.15, now);
  gain1.gain.exponentialRampToValueAtTime(0.01, now + duration);

  gain2.gain.setValueAtTime(0, now);
  gain2.gain.setValueAtTime(0.15, now + 0.1);
  gain2.gain.exponentialRampToValueAtTime(0.01, now + duration);

  osc1.start(now);
  osc1.stop(now + 0.15);
  osc2.start(now + 0.1);
  osc2.stop(now + duration);
}

// Sell: descending tone (warning)
function playSellSound() {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const now = ctx.currentTime;
  const duration = 0.3;

  // Descending two-note sequence for sell
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  const gain2 = ctx.createGain();

  osc1.frequency.setValueAtTime(1200, now);
  osc2.frequency.setValueAtTime(800, now);

  osc1.connect(gain1);
  osc2.connect(gain2);
  gain1.connect(ctx.destination);
  gain2.connect(ctx.destination);

  gain1.gain.setValueAtTime(0.15, now);
  gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

  gain2.gain.setValueAtTime(0, now);
  gain2.gain.setValueAtTime(0.15, now + 0.1);
  gain2.gain.exponentialRampToValueAtTime(0.01, now + duration);

  osc1.start(now);
  osc1.stop(now + 0.15);
  osc2.start(now + 0.1);
  osc2.stop(now + duration);
}

export function playOrderSound(side: "BUY" | "SELL") {
  if (!getSoundEnabled()) return;
  try {
    if (side === "BUY") {
      playBuySound();
    } else {
      playSellSound();
    }
  } catch (e) {
    // Audio context may not be available in some contexts
    console.debug("Sound notification unavailable:", e);
  }
}
