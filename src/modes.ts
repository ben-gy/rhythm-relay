/**
 * modes.ts — the shapes a track can take.
 *
 * Three knobs, and each mode turns all three together so it is a different game
 * rather than the same game with a number changed:
 *
 *   Warm-Up   short, thin, and slow-falling. `ceil` is under the chord
 *             threshold, so it is a strictly one-lane-at-a-time relay you can
 *             actually read — a track a first-timer finishes.
 *   Relay     the original: opens near-empty and builds for two and a half
 *             minutes. The mode where the interest is the ramp.
 *   Overdrive `floor` starts past halfway, so there is no build — it drops you
 *             in the busy part — and `leadSec` is roughly half Warm-Up's, so
 *             the limit stops being your hands and becomes your eyes.
 *
 * The host picks; the choice travels frozen inside the round start (see
 * engine/rematch.ts) alongside the seed, so every peer generates the same chart.
 * A mode each peer read from its own UI is a mode two peers can disagree about —
 * and here that means two peers judging each other's hits against different
 * notes.
 */

import { stepsFor, type ChartShape } from './chart';

export type ModeId = 'warmup' | 'relay' | 'overdrive';

export interface Mode {
  id: ModeId;
  name: string;
  /** Track length in seconds, count-in included. The track ENDS here. */
  lengthSec: number;
  /**
   * Note travel time from spawn to the hit line — i.e. how long you get to see
   * a note coming. This is the reaction-time knob, and the one players feel
   * first.
   */
  leadSec: number;
  shape: ChartShape;
  /** One line, shown under the name — say what it FEELS like, not the numbers. */
  blurb: string;
}

export const MODES: Record<ModeId, Mode> = {
  warmup: {
    id: 'warmup',
    name: 'Warm-Up',
    lengthSec: 60,
    leadSec: 2,
    shape: { density: 0.55, floor: 0, ceil: 0.45, rampSec: 30 },
    blurb: 'A minute, drifting down. One lane at a time, and time to read it.',
  },
  relay: {
    id: 'relay',
    name: 'Relay',
    lengthSec: 150,
    leadSec: 1.5,
    shape: { density: 1, floor: 0, ceil: 1, rampSec: 100 },
    blurb: 'Starts near-empty, ends frantic. Two and a half minutes of build.',
  },
  overdrive: {
    id: 'overdrive',
    name: 'Overdrive',
    lengthSec: 210,
    leadSec: 0.95,
    shape: { density: 1.3, floor: 0.55, ceil: 1, rampSec: 90 },
    blurb: 'No build — straight into the thick of it, and the notes fall fast.',
  },
};

export const DEFAULT_MODE: ModeId = 'relay';

export const MODE_LIST: Mode[] = [MODES.warmup, MODES.relay, MODES.overdrive];

/** Steps in this mode's track. Past the last one there is nothing left to play. */
export function stepsOf(m: Mode): number {
  return stepsFor(m.lengthSec);
}

/**
 * Resolve a mode id that arrived over the wire or out of storage.
 *
 * Never trust it: an older peer, a corrupted store or a hand-edited message
 * would otherwise hand `undefined` to the chart and the Rhythm sim — a track of
 * NaN steps that spawns nothing and never ends. Falling back keeps a mismatched
 * peer playing Relay rather than sitting on a dead field.
 *
 * hasOwn, not a truthiness check on MODES[id]: MODES is an object literal, so
 * `MODES['constructor']` is Object itself — truthy, and therefore returned as a
 * Mode whose every field is undefined. That is the exact dead track this guard
 * exists to prevent, reached through the one input it exists to distrust.
 */
export function modeOf(id: unknown): Mode {
  return typeof id === 'string' && Object.hasOwn(MODES, id)
    ? MODES[id as ModeId]
    : MODES[DEFAULT_MODE];
}
