/**
 * music.ts — the procedural groove. Zero audio assets: kick / snare / hats /
 * bass and a pentatonic melody blip per chart note, all synthesised from Web
 * Audio oscillators and noise.
 *
 * The scheduler uses a lookahead `setInterval` (NOT requestAnimationFrame) so
 * the beat keeps perfect time even when the tab is backgrounded and rAF is
 * throttled — the standard Web-Audio scheduling pattern, and exactly what the
 * factory's netcode guidance asks for on time-based logic.
 *
 * Audio is anchored to the SAME game clock the visuals use (`getNow()` → game
 * seconds), so taps, falling notes, and the beat all line up.
 */

import { DEFAULT_SHAPE, STEP_SEC, STEPS_PER_BEAT, stepNotes, stepTime, type ChartShape, type Lane } from './chart';

const LOOKAHEAD = 0.12; // schedule this many seconds ahead
const TICK_MS = 25;

// A minor pentatonic across two octaves (Hz) for the melody blips.
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

export interface Music {
  unlock(): void;
  reset(): void;
  start(getNow: () => number): void;
  stop(): void;
  setMuted(m: boolean): void;
  dispose(): void;
}

/**
 * `shape` must be the same one the sim is playing: the melody is the chart, so a
 * groove built on a different shape would blip notes that are not falling.
 */
export function createMusic(seed: string, shape: ChartShape = DEFAULT_SHAPE): Music {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let getNow: (() => number) | null = null;
  let audioOffset = 0; // ctxTime = gameTime + audioOffset
  let nextStep = 0;

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  function kick(t: number): void {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.15);
  }

  function noiseBurst(t: number, dur: number, gain: number, hp = 0): void {
    if (!ctx || !master) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    let node: AudioNode = src;
    if (hp > 0) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hp;
      src.connect(f);
      node = f;
    }
    node.connect(g).connect(master);
    src.start(t);
    src.stop(t + dur);
  }

  function snare(t: number): void {
    if (!ctx || !master) return;
    noiseBurst(t, 0.14, 0.35, 1200);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(190, t);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.13);
  }

  function hat(t: number): void {
    noiseBurst(t, 0.03, 0.12, 7000);
  }

  function bass(t: number, freq: number): void {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.26);
  }

  function blip(t: number, freq: number, lane: Lane): void {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = lane === 0 ? -0.4 : 0.4;
    o.type = 'square';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g).connect(pan).connect(master);
    o.start(t);
    o.stop(t + 0.18);
  }

  function scheduleStep(step: number, t: number): void {
    if (muted) return;
    // Percussion groove (16 steps per bar).
    const inBar = ((step % 16) + 16) % 16;
    if (step % STEPS_PER_BEAT === 0) kick(t);
    if (inBar === 4 || inBar === 12) snare(t);
    if (step % 2 === 0) hat(t);
    if (inBar === 0) bass(t, SCALE[0] / 2);
    else if (inBar === 8) bass(t, SCALE[2] / 2);

    // Melody blips follow the actual chart notes.
    const sn = stepNotes(seed, step, shape);
    if (sn.left) blip(t, SCALE[(step * 2) % SCALE.length], 0);
    if (sn.right) blip(t, SCALE[(step * 3 + 4) % SCALE.length], 1);
  }

  function tick(): void {
    if (!ctx || !getNow) return;
    // Re-anchor gently if the game clock drifts (e.g. after resume).
    const ctxTimeFor = (gameT: number) => gameT + audioOffset;
    const horizon = ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (ctxTimeFor(stepTime(nextStep)) < horizon && guard < 256) {
      scheduleStep(nextStep, ctxTimeFor(stepTime(nextStep)));
      nextStep++;
      guard++;
    }
  }

  return {
    unlock() {
      ensure();
    },
    reset() {
      nextStep = 0;
    },
    start(now) {
      const ac = ensure();
      if (!ac) return;
      getNow = now;
      // Anchor the audio clock to the current game time.
      audioOffset = ac.currentTime - now();
      // Never re-schedule a step that already passed (resume-safe).
      const cur = Math.ceil(now() / STEP_SEC);
      if (cur > nextStep) nextStep = cur;
      if (timer == null) timer = setInterval(tick, TICK_MS);
      tick();
    },
    stop() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    setMuted(m) {
      muted = m;
    },
    dispose() {
      this.stop();
      if (ctx) {
        try {
          void ctx.close();
        } catch {
          /* already closed */
        }
        ctx = null;
        master = null;
      }
    },
  };
}
