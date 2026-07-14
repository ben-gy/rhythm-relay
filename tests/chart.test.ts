/**
 * The chart is a pure function of (seed, step). Two peers with the same lobby
 * seed MUST generate byte-identical charts — this is the co-op sync invariant
 * for note timing. Also guards the musical structure (intro, ramp, both lanes).
 */
import { describe, expect, it } from 'vitest';
import { INTRO_STEPS, intensityAt, stepNotes, stepTime } from '../src/chart';

function chart(seed: string, steps: number) {
  return Array.from({ length: steps }, (_, i) => stepNotes(seed, i));
}

describe('chart determinism (P2P sync invariant)', () => {
  it('two peers with the same seed generate an identical chart', () => {
    expect(chart('ROOM42', 3000)).toEqual(chart('ROOM42', 3000));
  });

  it('different seeds produce different charts', () => {
    expect(chart('ROOM42', 3000)).not.toEqual(chart('ROOM99', 3000));
  });

  it('is order-independent (any step reproduces on its own)', () => {
    for (const step of [17, 128, 733, 2044]) {
      expect(stepNotes('seedX', step)).toEqual(stepNotes('seedX', step));
    }
  });
});

describe('musical structure', () => {
  it('has an empty count-in before the first note', () => {
    for (let s = 0; s < INTRO_STEPS; s++) {
      expect(stepNotes('anything', s)).toEqual({ left: false, right: false });
    }
  });

  it('produces notes in both lanes over a run', () => {
    const c = chart('bothLanes', 2000);
    expect(c.some((n) => n.left)).toBe(true);
    expect(c.some((n) => n.right)).toBe(true);
  });

  it('gets denser as intensity ramps', () => {
    const early = chart('ramp', 200).slice(INTRO_STEPS).filter((n) => n.left || n.right).length;
    const late = Array.from({ length: 200 }, (_, i) => stepNotes('ramp', 2000 + i)).filter(
      (n) => n.left || n.right,
    ).length;
    expect(late).toBeGreaterThan(early);
  });

  it('intensity is monotonic non-decreasing and clamped to [0,1]', () => {
    let prev = -1;
    for (let s = 0; s <= 5000; s += 50) {
      const v = intensityAt(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('step time advances by the 16th-note grid', () => {
    expect(stepTime(0)).toBe(0);
    expect(stepTime(8)).toBeCloseTo(1.0, 6); // 8 * 0.125s
  });
});
