// Procedural sound effects via the Web Audio API. No binary assets: every blip
// is synthesised from oscillators + an envelope, matching the "all assets
// authored" goal and keeping the bundle tiny. A single shared AudioContext is
// created lazily and resumed on the first user gesture (autoplay policy).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = localStorage.getItem("bg-muted") === "1";

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Call from a user gesture so the browser allows playback. */
export function resumeAudio(): void {
  const c = ensure();
  if (c && c.state === "suspended") void c.resume();
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMuted(): boolean {
  muted = !muted;
  localStorage.setItem("bg-muted", muted ? "1" : "0");
  return muted;
}

interface Tone {
  freq: number;
  to?: number; // glide target frequency
  dur: number; // seconds
  type?: OscillatorType;
  gain?: number;
  delay?: number; // seconds from now
}

function play(tones: Tone[]): void {
  if (muted) return;
  const c = ensure();
  if (!c || !master) return;
  if (c.state === "suspended") void c.resume();
  const now = c.currentTime;
  for (const t of tones) {
    const osc = c.createOscillator();
    const g = c.createGain();
    const start = now + (t.delay ?? 0);
    const peak = t.gain ?? 0.6;
    osc.type = t.type ?? "sine";
    osc.frequency.setValueAtTime(t.freq, start);
    if (t.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, t.to), start + t.dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + t.dur + 0.02);
  }
}

// ---- named effects -------------------------------------------------------

export const sfx = {
  select: () => play([{ freq: 660, dur: 0.07, type: "triangle", gain: 0.4 }]),
  command: () => play([{ freq: 520, to: 720, dur: 0.09, type: "square", gain: 0.25 }]),
  attack: () =>
    play([
      { freq: 300, to: 140, dur: 0.12, type: "sawtooth", gain: 0.4 },
      { freq: 180, dur: 0.1, type: "square", gain: 0.2, delay: 0.02 },
    ]),
  build: () =>
    play([
      { freq: 220, dur: 0.08, type: "square", gain: 0.3 },
      { freq: 330, dur: 0.1, type: "square", gain: 0.3, delay: 0.07 },
    ]),
  ready: () =>
    play([
      { freq: 587, dur: 0.09, type: "triangle", gain: 0.35 },
      { freq: 880, dur: 0.12, type: "triangle", gain: 0.35, delay: 0.08 },
    ]),
  complete: () =>
    play([
      { freq: 523, dur: 0.1, type: "sine", gain: 0.4 },
      { freq: 659, dur: 0.1, type: "sine", gain: 0.4, delay: 0.09 },
      { freq: 784, dur: 0.16, type: "sine", gain: 0.4, delay: 0.18 },
    ]),
  error: () => play([{ freq: 200, to: 120, dur: 0.18, type: "sawtooth", gain: 0.3 }]),
  // urgent two-tone klaxon for "your base/army is under attack"
  alert: () =>
    play([
      { freq: 740, dur: 0.16, type: "square", gain: 0.32 },
      { freq: 560, dur: 0.22, type: "square", gain: 0.32, delay: 0.16 },
    ]),
  win: () =>
    play([
      { freq: 523, dur: 0.16, type: "triangle", gain: 0.5 },
      { freq: 659, dur: 0.16, type: "triangle", gain: 0.5, delay: 0.15 },
      { freq: 784, dur: 0.16, type: "triangle", gain: 0.5, delay: 0.3 },
      { freq: 1047, dur: 0.3, type: "triangle", gain: 0.5, delay: 0.45 },
    ]),
  lose: () =>
    play([
      { freq: 392, dur: 0.2, type: "sine", gain: 0.45 },
      { freq: 311, dur: 0.2, type: "sine", gain: 0.45, delay: 0.18 },
      { freq: 233, dur: 0.4, type: "sine", gain: 0.45, delay: 0.36 },
    ]),
};
