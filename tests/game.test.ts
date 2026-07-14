/**
 * Simulation logic: judgement windows, scoring/multiplier, combo, energy drain,
 * game over, the authoritative gate, and host-applied remote hits.
 */
import { describe, expect, it } from 'vitest';
import { GOOD_WINDOW, PERFECT_WINDOW, Rhythm, multiplierFor, ratingForOffset } from '../src/game';

function spawned(seed = 'g', now = 2.0) {
  const r = new Rhythm({ seed, ownLanes: [0, 1], authoritative: true });
  r.update(now);
  return r;
}

describe('multiplierFor', () => {
  it('tiers up with combo length', () => {
    expect(multiplierFor(0)).toBe(1);
    expect(multiplierFor(9)).toBe(1);
    expect(multiplierFor(10)).toBe(2);
    expect(multiplierFor(25)).toBe(4);
    expect(multiplierFor(50)).toBe(8);
    expect(multiplierFor(999)).toBe(8);
  });
});

describe('ratingForOffset', () => {
  it('classifies timing windows', () => {
    expect(ratingForOffset(0)).toBe('perfect');
    expect(ratingForOffset(PERFECT_WINDOW)).toBe('perfect');
    expect(ratingForOffset(PERFECT_WINDOW + 0.001)).toBe('good');
    expect(ratingForOffset(GOOD_WINDOW)).toBe('good');
    expect(ratingForOffset(GOOD_WINDOW + 0.001)).toBe(null);
  });
});

describe('hit judgement + scoring', () => {
  it('a dead-on tap is perfect and scores 100 at ×1', () => {
    const r = spawned();
    expect(r.notes.length).toBeGreaterThan(0);
    const note = r.notes[0];
    const res = r.hit(note.lane, note.time);
    expect(res?.result).toBe('perfect');
    const s = r.getState();
    expect(s.combo).toBe(1);
    expect(s.score).toBe(100);
    expect(s.perfect).toBe(1);
  });

  it('a slightly-off tap is good and scores 50', () => {
    const r = spawned();
    const note = r.notes[0];
    const res = r.hit(note.lane, note.time + PERFECT_WINDOW + 0.02);
    expect(res?.result).toBe('good');
    expect(r.getState().score).toBe(50);
  });

  it('a whiff (no note in window) returns null and keeps the combo', () => {
    const r = new Rhythm({ seed: 'g', ownLanes: [0, 1], authoritative: true });
    r.update(0.3); // still the intro — nothing to hit
    expect(r.hit(0, 0.3)).toBe(null);
    expect(r.getState().combo).toBe(0);
  });

  it('the multiplier tiers up once the combo is high (perfect run)', () => {
    const r = new Rhythm({ seed: 'g', ownLanes: [0, 1], authoritative: true });
    // Perfectly hit every note the moment it lands so the combo never breaks.
    let now = 0;
    while (r.getState().combo < 12 && now < 20) {
      now += 0.02; // dt < GOOD_WINDOW so no note is ever missed
      r.update(now);
      for (const n of r.notes) {
        if (!n.judged && n.time <= now && now - n.time <= GOOD_WINDOW) r.hit(n.lane, n.time);
      }
    }
    const s = r.getState();
    expect(s.combo).toBeGreaterThanOrEqual(12);
    expect(s.miss).toBe(0);
    expect(s.multiplier).toBeGreaterThanOrEqual(2);
  });
});

describe('misses', () => {
  it('an un-hit note breaks the combo and drains energy', () => {
    const r = spawned();
    const note = r.notes.find((n) => !n.judged)!;
    const before = r.getState().energy;
    r.update(note.time + 0.25); // pass its window without a tap
    expect(note.result).toBe('miss');
    const s = r.getState();
    expect(s.miss).toBeGreaterThanOrEqual(1);
    expect(s.combo).toBe(0);
    expect(s.energy).toBeLessThan(before);
  });

  it('draining all energy ends the run', () => {
    const r = new Rhythm({ seed: 'g', ownLanes: [0, 1], authoritative: true });
    r.update(60); // jump far ahead: many notes pass un-hit
    const s = r.getState();
    expect(s.over).toBe(true);
    expect(s.energy).toBe(0);
    expect(s.miss).toBeGreaterThan(0);
  });
});

describe('authoritative gate + remote hits', () => {
  it('a non-authoritative (client) core never mutates the shared score', () => {
    const c = new Rhythm({ seed: 'g', ownLanes: [0, 1], authoritative: false });
    c.update(2.0);
    const note = c.notes[0];
    const res = c.hit(note.lane, note.time);
    expect(res?.result).toBe('perfect'); // still judged locally for feedback
    expect(c.getState().score).toBe(0); // but shared state comes from snapshots
  });

  it('the host applies a client-reported hit to the shared state', () => {
    const h = new Rhythm({ seed: 'g', ownLanes: [0], authoritative: true });
    h.update(2.0);
    const note = h.notes[0];
    h.applyRemoteHit(note.lane, note.step, 'good');
    expect(note.judged).toBe(true);
    expect(h.getState().score).toBe(50);
    expect(h.getState().combo).toBe(1);
  });
});
