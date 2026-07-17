/**
 * Netcode serialization: snapshot and hit/flash encodings must round-trip
 * exactly, or a co-op peer reads garbage state.
 */
import { describe, expect, it } from 'vitest';
import type { GameState } from '../src/game';
import {
  codeToJudge,
  decodeFlash,
  flashCode,
  judgeToCode,
  packSnap,
  unpackSnap,
} from '../src/net-game';

const sample: GameState = {
  energy: 73.4,
  combo: 41,
  maxCombo: 55,
  multiplier: 4,
  score: 128350,
  perfect: 190,
  good: 60,
  miss: 7,
  over: false,
};

describe('snapshot round-trip', () => {
  it('preserves the shared state through pack → unpack', () => {
    const restored = unpackSnap(packSnap(sample, []));
    expect(restored.combo).toBe(sample.combo);
    expect(restored.multiplier).toBe(sample.multiplier);
    expect(restored.score).toBe(sample.score);
    expect(restored.perfect).toBe(sample.perfect);
    expect(restored.good).toBe(sample.good);
    expect(restored.miss).toBe(sample.miss);
    expect(restored.over).toBe(false);
    expect(restored.energy).toBe(73); // energy is rounded for the wire
  });

  it('carries maxCombo independently of the current combo', () => {
    // maxCombo used to be aliased to `c` on unpack, so a client whose combo had
    // just been broken showed "max combo 0" on the results screen.
    const broken = { ...sample, combo: 0, maxCombo: 55 };
    expect(unpackSnap(packSnap(broken, [])).maxCombo).toBe(55);
  });

  it('carries the over flag', () => {
    expect(unpackSnap(packSnap({ ...sample, over: true }, [])).over).toBe(true);
  });

  it('carries the flash list', () => {
    const flashes = [flashCode(0, 'perfect'), flashCode(1, 'miss')];
    expect(packSnap(sample, flashes).fl).toEqual(flashes);
  });
});

describe('judge codes', () => {
  it('round-trip every judgement', () => {
    for (const j of ['perfect', 'good', 'miss'] as const) {
      expect(codeToJudge(judgeToCode(j))).toBe(j);
    }
  });
});

describe('flash codes', () => {
  it('round-trip lane + result', () => {
    for (const lane of [0, 1] as const) {
      for (const result of ['perfect', 'good', 'miss'] as const) {
        expect(decodeFlash(flashCode(lane, result))).toEqual({ lane, result });
      }
    }
  });
});
