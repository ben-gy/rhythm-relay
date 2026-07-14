/**
 * sound.ts — procedural UI sound effects via the Web Audio API. Zero assets.
 * Copied from patterns/ and extended with rhythm-relay UI blips. The in-game
 * musical groove lives in ../music.ts; this handles menu/HUD feedback.
 */

export type SfxName =
  | 'blip'
  | 'select'
  | 'coin'
  | 'jump'
  | 'hit'
  | 'explosion'
  | 'powerup'
  | 'lose'
  | 'win';

interface Patch {
  type: OscillatorType;
  freq: [number, number];
  dur: number;
  gain?: number;
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  blip: { type: 'square', freq: [440, 620], dur: 0.06, gain: 0.2 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.09, gain: 0.22 },
  coin: { type: 'square', freq: [880, 1320], dur: 0.12, gain: 0.2 },
  jump: { type: 'sine', freq: [320, 720], dur: 0.16, gain: 0.25 },
  hit: { type: 'sawtooth', freq: [300, 90], dur: 0.14, gain: 0.28, noise: true },
  explosion: { type: 'sawtooth', freq: [180, 40], dur: 0.5, gain: 0.35, noise: true },
  powerup: { type: 'square', freq: [520, 1040], dur: 0.3, gain: 0.22 },
  lose: { type: 'sawtooth', freq: [400, 120], dur: 0.5, gain: 0.3 },
  win: { type: 'triangle', freq: [520, 1040], dur: 0.5, gain: 0.28 },
};

export interface Sfx {
  unlock(): void;
  play(name: SfxName): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },
    play(name) {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      const p = PATCHES[name];
      const t0 = ac.currentTime;
      const g = ac.createGain();
      g.gain.setValueAtTime(p.gain ?? 0.25, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
      g.connect(ac.destination);

      const osc = ac.createOscillator();
      osc.type = p.type;
      osc.frequency.setValueAtTime(p.freq[0], t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1]), t0 + p.dur);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + p.dur);

      if (p.noise) {
        const n = ac.createBufferSource();
        n.buffer = noiseBuffer(ac, p.dur);
        const ng = ac.createGain();
        ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.6, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        n.connect(ng);
        ng.connect(ac.destination);
        n.start(t0);
        n.stop(t0 + p.dur);
      }
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
