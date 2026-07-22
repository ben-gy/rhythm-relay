// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * chart.ts — deterministic note-chart generation.
 *
 * The chart is a PURE function of (seed, step, shape): every peer that shares
 * the lobby seed AND the host's mode generates a byte-identical track, so co-op
 * needs no chart syncing. Each step uses its own sub-seeded RNG
 * (`makeRng(`${seed}:${step}`)`) so the result is order-independent and
 * trivially testable.
 *
 * Musical structure (constant 120 BPM, 16th-note grid):
 *  - downbeats almost always carry a note,
 *  - backbeats/offbeats fill in more as the track's intensity ramps,
 *  - the active lane oscillates left↔right every half-beat (the "relay"),
 *  - strong downbeats become two-lane chords once the track is intense.
 *
 * The track's LENGTH is not here: this file answers "what is at step N", and a
 * mode decides how many steps there are (see modes.ts, game.ts).
 */

import { makeRng } from '@ben-gy/game-engine/rng';

export type Lane = 0 | 1;

export const BPM = 120;
export const STEPS_PER_BEAT = 4; // 16th notes
export const STEP_SEC = 60 / BPM / STEPS_PER_BEAT; // 0.125s

/** Steps before the first note (a ~2s count-in over the intro groove). */
export const INTRO_STEPS = 16;
const INTRO_SEC = INTRO_STEPS * STEP_SEC;

/**
 * The knobs a mode turns to make a different track out of the same generator.
 *
 * This travels frozen inside the round start with the seed, so it is part of the
 * co-op sync invariant: two peers on different shapes are two peers playing
 * different charts while judging each other's hits by step number.
 */
export interface ChartShape {
  /**
   * Scales how often a step OFF the downbeat carries a note. Downbeats are
   * deliberately untouched — thinning them out would take away the pulse the
   * whole relay is read against, which is not "easier", it is unreadable.
   */
  density: number;
  /** Intensity the track opens at once the count-in is over. */
  floor: number;
  /** Intensity the track tops out at. */
  ceil: number;
  /** Seconds from the first note to `ceil`. */
  rampSec: number;
}

/** The shape the original endless track had. Also what an unknown mode gets. */
export const DEFAULT_SHAPE: ChartShape = { density: 1, floor: 0, ceil: 1, rampSec: 100 };

export interface StepNotes {
  left: boolean;
  right: boolean;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Wall-clock target time (seconds) at which a note on `step` reaches the line. */
export function stepTime(step: number): number {
  return step * STEP_SEC;
}

/** How many steps a track of `lengthSec` holds, count-in included. */
export function stepsFor(lengthSec: number): number {
  return Math.round(lengthSec / STEP_SEC);
}

/** 0..1 track intensity at a given step — drives density and syncopation. */
export function intensityAt(step: number, shape: ChartShape = DEFAULT_SHAPE): number {
  const ramp = clamp01((stepTime(step) - INTRO_SEC) / shape.rampSec);
  return shape.floor + (shape.ceil - shape.floor) * ramp;
}

/** What notes (if any) land on this step. Deterministic per (seed, step, shape). */
export function stepNotes(seed: string, step: number, shape: ChartShape = DEFAULT_SHAPE): StepNotes {
  if (step < INTRO_STEPS) return { left: false, right: false };

  const r = makeRng(`${seed}:${step}`);
  const intensity = intensityAt(step, shape);
  const onBeat = step % STEPS_PER_BEAT === 0;
  const halfBeat = step % 2 === 0;

  let p: number;
  if (onBeat) p = 0.85;
  else if (halfBeat) p = clamp01((0.28 + 0.42 * intensity) * shape.density);
  else p = clamp01((0.06 + 0.5 * intensity) * shape.density);

  if (r() > p) return { left: false, right: false };

  // Relay: the active lane oscillates every half-beat, with occasional variation.
  let lane: Lane = ((Math.floor(step / 2) % 2) as Lane);
  if (r() < 0.18) lane = (1 - lane) as Lane;

  // Two-lane chords on strong downbeats once the track is intense. A shape whose
  // ceil never reaches 0.45 therefore never produces one — that is the point of
  // Warm-Up, not an accident: it stays a strictly one-hand-at-a-time relay.
  const strongDown = step % 8 === 0;
  if (strongDown && intensity > 0.45 && r() < (intensity - 0.3) * 0.7) {
    return { left: true, right: true };
  }

  return { left: lane === 0, right: lane === 1 };
}
