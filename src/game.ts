/**
 * game.ts — the Rhythm Relay simulation (clock-injected, so it's fully
 * testable headlessly and drives both solo and co-op).
 *
 * One `Rhythm` instance walks the deterministic chart, owns note lifecycle,
 * judges local-lane taps, and — when `authoritative` — maintains the shared
 * energy / combo / multiplier / score and detects missed notes.
 *
 *   Solo : authoritative, ownLanes = [0, 1]  (you play both lanes)
 *   Host : authoritative, ownLanes = [0]      (host plays the left lane,
 *          applies the client's right-lane hits via applyRemoteHit)
 *   Client: view-only,     ownLanes = [1]      (renders + judges its lane for
 *          instant feedback; shared state comes from host snapshots)
 */

import { LEAD_SEC, stepNotes, stepTime, type Lane } from './chart';

export type { Lane };
export type Judge = 'perfect' | 'good' | 'miss';

export const PERFECT_WINDOW = 0.05; // ±50ms
export const GOOD_WINDOW = 0.12; // ±120ms
const REMOTE_GRACE = 0.25; // extra time the host waits for a networked hit
const MISS_DRAIN = 10;
const START_ENERGY = 100;
const MAX_ENERGY = 100;
const MAX_STEP = 200000; // safety cap on the endless walk

export interface Note {
  id: number;
  step: number;
  lane: Lane;
  time: number;
  judged: boolean;
  result: Judge | null;
  /** Seconds since judgement, for the hit/miss burst animation. */
  flash: number;
}

export interface GameState {
  energy: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  score: number;
  perfect: number;
  good: number;
  miss: number;
  over: boolean;
}

export interface JudgeEvent {
  lane: Lane;
  result: Judge;
  combo: number;
}

export interface RhythmConfig {
  seed: string;
  ownLanes: Lane[];
  authoritative: boolean;
  /** Fired on every judged note this peer is responsible for (for juice). */
  onJudge?: (ev: JudgeEvent) => void;
}

/** Score multiplier tier for a combo length. */
export function multiplierFor(combo: number): number {
  if (combo >= 50) return 8;
  if (combo >= 25) return 4;
  if (combo >= 10) return 2;
  return 1;
}

/** Judge a timing offset (absolute seconds) into a rating, or null if a whiff. */
export function ratingForOffset(dt: number): 'perfect' | 'good' | null {
  if (dt <= PERFECT_WINDOW) return 'perfect';
  if (dt <= GOOD_WINDOW) return 'good';
  return null;
}

export class Rhythm {
  readonly notes: Note[] = [];
  private state: GameState = {
    energy: START_ENERGY,
    combo: 0,
    maxCombo: 0,
    multiplier: 1,
    score: 0,
    perfect: 0,
    good: 0,
    miss: 0,
    over: false,
  };
  private nextStep = 0;
  private nextId = 1;
  private readonly own: Set<Lane>;

  constructor(private cfg: RhythmConfig) {
    this.own = new Set(cfg.ownLanes);
  }

  getState(): Readonly<GameState> {
    return this.state;
  }

  ownsLane(lane: Lane): boolean {
    return this.own.has(lane);
  }

  /** Spawn upcoming notes and resolve overdue ones. `now` is game seconds. */
  update(now: number): void {
    // Spawn every note whose travel window has opened.
    while (this.nextStep < MAX_STEP && stepTime(this.nextStep) - LEAD_SEC <= now + 0.1) {
      const sn = stepNotes(this.cfg.seed, this.nextStep);
      const t = stepTime(this.nextStep);
      if (sn.left) this.spawn(this.nextStep, 0, t);
      if (sn.right) this.spawn(this.nextStep, 1, t);
      this.nextStep++;
    }

    for (const n of this.notes) {
      if (n.judged) continue; // flash timers advance in advanceFlash()
      const grace = this.own.has(n.lane) ? GOOD_WINDOW : GOOD_WINDOW + REMOTE_GRACE;
      if (now > n.time + grace) {
        // Overdue and un-hit.
        if (this.cfg.authoritative) {
          this.resolveMiss(n);
        } else if (this.own.has(n.lane)) {
          // Client visual-only miss for its own lane.
          n.judged = true;
          n.result = 'miss';
          n.flash = 0;
          this.cfg.onJudge?.({ lane: n.lane, result: 'miss', combo: 0 });
        } else {
          // Remote lane on a client: fade without scoring effect.
          n.judged = true;
          n.result = null;
          n.flash = 0;
        }
      }
    }

    this.prune(now);
  }

  /** Advance judged-note flash timers by `dt` seconds (called each render). */
  advanceFlash(dt: number): void {
    for (const n of this.notes) if (n.judged) n.flash += dt;
  }

  /**
   * A local tap on `lane` at game time `now`. Returns the judged note's rating
   * and step (so co-op can report it), or null on a whiff / non-owned lane.
   */
  hit(lane: Lane, now: number): { result: Judge; step: number } | null {
    if (!this.own.has(lane) || this.state.over) return null;
    const note = this.nearestHittable(lane, now);
    if (!note) return null;
    const rating = ratingForOffset(Math.abs(now - note.time));
    if (!rating) return null;
    note.judged = true;
    note.result = rating;
    note.flash = 0;
    if (this.cfg.authoritative) this.applyHit(rating);
    this.cfg.onJudge?.({ lane, result: rating, combo: this.state.combo });
    return { result: rating, step: note.step };
  }

  /** Host-side: apply a hit a client reported for a lane it owns. */
  applyRemoteHit(lane: Lane, step: number, result: Judge): void {
    if (!this.cfg.authoritative || this.state.over) return;
    const note = this.notes.find((n) => n.step === step && n.lane === lane && !n.judged);
    if (!note) return;
    note.judged = true;
    note.result = result;
    note.flash = 0;
    if (result === 'miss') this.resolveMiss(note, true);
    else {
      this.applyHit(result);
      this.cfg.onJudge?.({ lane, result, combo: this.state.combo });
    }
  }

  /** Client-side: overwrite shared state from a host snapshot. */
  applySnapshot(s: GameState): void {
    this.state = { ...s };
  }

  /**
   * Promote a view-only client to the authoritative host — its co-op partner
   * (the old host) left, and net.ts re-elected this peer. Owning `lanes` too
   * means the abandoned lane becomes this player's to hit rather than silently
   * auto-missing on nobody, so the survivor keeps a real, finishable run.
   */
  takeOver(lanes: Lane[]): void {
    this.cfg = { ...this.cfg, authoritative: true };
    for (const l of lanes) this.own.add(l);
  }

  private nearestHittable(lane: Lane, now: number): Note | null {
    let best: Note | null = null;
    let bestDt = Infinity;
    for (const n of this.notes) {
      if (n.lane !== lane || n.judged) continue;
      const dt = Math.abs(now - n.time);
      if (dt <= GOOD_WINDOW && dt < bestDt) {
        best = n;
        bestDt = dt;
      }
    }
    return best;
  }

  private spawn(step: number, lane: Lane, time: number): void {
    this.notes.push({ id: this.nextId++, step, lane, time, judged: false, result: null, flash: 0 });
  }

  private applyHit(rating: 'perfect' | 'good'): void {
    const s = this.state;
    s.combo++;
    s.maxCombo = Math.max(s.maxCombo, s.combo);
    s.multiplier = multiplierFor(s.combo);
    s.score += (rating === 'perfect' ? 100 : 50) * s.multiplier;
    s.energy = Math.min(MAX_ENERGY, s.energy + (rating === 'perfect' ? 2 : 1));
    if (rating === 'perfect') s.perfect++;
    else s.good++;
  }

  private resolveMiss(n: Note, silent = false): void {
    n.judged = true;
    n.result = 'miss';
    n.flash = 0;
    const s = this.state;
    s.combo = 0;
    s.multiplier = 1;
    s.miss++;
    s.energy = Math.max(0, s.energy - MISS_DRAIN);
    if (s.energy <= 0) s.over = true;
    if (!silent) this.cfg.onJudge?.({ lane: n.lane, result: 'miss', combo: 0 });
  }

  private prune(now: number): void {
    // Drop notes that have finished their flash and scrolled well past the line.
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.judged && now > n.time + 0.8) this.notes.splice(i, 1);
    }
  }
}
