/**
 * chart.ts — deterministic note-chart generation.
 *
 * The chart is a PURE function of (seed, step): every peer that shares the
 * lobby seed generates a byte-identical track, so co-op needs no chart syncing.
 * Each step uses its own sub-seeded RNG (`makeRng(`${seed}:${step}`)`) so the
 * result is order-independent and trivially testable.
 *
 * Musical structure (constant 120 BPM, 16th-note grid):
 *  - downbeats almost always carry a note,
 *  - backbeats/offbeats fill in more as the track's intensity ramps,
 *  - the active lane oscillates left↔right every half-beat (the "relay"),
 *  - strong downbeats become two-lane chords once the track is intense.
 */

import { makeRng } from './engine/rng';

export type Lane = 0 | 1;

export const BPM = 120;
export const STEPS_PER_BEAT = 4; // 16th notes
export const STEP_SEC = 60 / BPM / STEPS_PER_BEAT; // 0.125s
export const LEAD_SEC = 1.5; // note travel time from spawn to the hit line

/** Steps before the first note (a ~2s count-in over the intro groove). */
export const INTRO_STEPS = 16;
const INTRO_SEC = INTRO_STEPS * STEP_SEC;
const RAMP_SEC = 100; // seconds over which the track ramps to full intensity

export interface StepNotes {
  left: boolean;
  right: boolean;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Wall-clock target time (seconds) at which a note on `step` reaches the line. */
export function stepTime(step: number): number {
  return step * STEP_SEC;
}

/** 0..1 track intensity at a given step — drives density and syncopation. */
export function intensityAt(step: number): number {
  return clamp01((stepTime(step) - INTRO_SEC) / RAMP_SEC);
}

/** What notes (if any) land on this step. Deterministic per (seed, step). */
export function stepNotes(seed: string, step: number): StepNotes {
  if (step < INTRO_STEPS) return { left: false, right: false };

  const r = makeRng(`${seed}:${step}`);
  const intensity = intensityAt(step);
  const onBeat = step % STEPS_PER_BEAT === 0;
  const halfBeat = step % 2 === 0;

  let p: number;
  if (onBeat) p = 0.85;
  else if (halfBeat) p = 0.28 + 0.42 * intensity;
  else p = 0.06 + 0.5 * intensity;

  if (r() > p) return { left: false, right: false };

  // Relay: the active lane oscillates every half-beat, with occasional variation.
  let lane: Lane = ((Math.floor(step / 2) % 2) as Lane);
  if (r() < 0.18) lane = (1 - lane) as Lane;

  // Two-lane chords on strong downbeats once the track is intense.
  const strongDown = step % 8 === 0;
  if (strongDown && intensity > 0.45 && r() < (intensity - 0.3) * 0.7) {
    return { left: true, right: true };
  }

  return { left: lane === 0, right: lane === 1 };
}
