import { useState, useRef, useCallback, useEffect } from 'react';

/*
 * Optional host sound cues, synthesized with the Web Audio API (no audio files
 * to ship, no network, no codec concerns). Cues: question start, last-10s
 * warning, time up, results reveal.
 *
 * Mobile autoplay safety: browsers block audio until a user gesture. We create
 * (or resume) the AudioContext on the first call to unlock() — wire that to the
 * admin's first tap (e.g. "Start question"). If the context can't start, every
 * play() call simply no-ops; the app stays fully usable.
 *
 * The on/off preference is persisted to localStorage. Default: off (the host
 * opts in), so nothing ever plays unexpectedly.
 */

const STORAGE_KEY = 'bbqa.sound';

function readPref() {
  try { return localStorage.getItem(STORAGE_KEY) === 'on'; } catch { return false; }
}
function writePref(on) {
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
}

// Cue definitions: a small sequence of (frequency, start, duration) beeps.
const CUES = {
  start:   [{ f: 660, t: 0,    d: 0.12 }, { f: 880, t: 0.12, d: 0.16 }],
  warning: [{ f: 520, t: 0,    d: 0.10 }, { f: 520, t: 0.18, d: 0.10 }],
  timeup:  [{ f: 400, t: 0,    d: 0.18 }, { f: 300, t: 0.20, d: 0.28 }],
  reveal:  [{ f: 523, t: 0,    d: 0.12 }, { f: 659, t: 0.12, d: 0.12 }, { f: 784, t: 0.24, d: 0.22 }],
};

export function useSound() {
  const [enabled, setEnabled] = useState(readPref);
  const ctxRef = useRef(null);

  const ensureCtx = useCallback(() => {
    if (ctxRef.current) return ctxRef.current;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctxRef.current = new AC();
    } catch {
      ctxRef.current = null;
    }
    return ctxRef.current;
  }, []);

  // Call from a user gesture to satisfy mobile autoplay policies.
  const unlock = useCallback(() => {
    const ctx = ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }, [ensureCtx]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      writePref(next);
      if (next) unlock(); // toggling on is itself a gesture — unlock now
      return next;
    });
  }, [unlock]);

  const play = useCallback((cueName) => {
    if (!enabled) return;
    const cue = CUES[cueName];
    if (!cue) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const now = ctx.currentTime;
    try {
      for (const beep of cue) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = beep.f;
        // Soft attack/decay envelope to avoid clicks.
        gain.gain.setValueAtTime(0.0001, now + beep.t);
        gain.gain.exponentialRampToValueAtTime(0.18, now + beep.t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + beep.t + beep.d);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + beep.t);
        osc.stop(now + beep.t + beep.d + 0.02);
      }
    } catch { /* ignore audio errors */ }
  }, [enabled, ensureCtx]);

  // Clean up the context on unmount.
  useEffect(() => {
    return () => {
      const ctx = ctxRef.current;
      if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);

  return { enabled, toggle, play, unlock };
}
