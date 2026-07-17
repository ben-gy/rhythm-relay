/**
 * modes.test.ts — the host's track is what the room plays, and all three are
 * genuinely different games that a player can actually finish.
 *
 * A mode here is not a difficulty number: it changes the chart every peer
 * generates. So if two peers resolve it differently they are not merely playing
 * at different speeds — they are looking at different notes while judging each
 * other's hits by step index, which is the same class of bug as the roster drift
 * that put lanes on the wrong player. The mode therefore travels frozen inside
 * the round start, and these tests pin that.
 *
 * The second half is viability. "Overdrive is 210 seconds at 1.3× density" is a
 * claim, not a fact, until something plays it: a track nobody can finish, or one
 * whose generator is too slow to spawn from inside the sim loop, is not a mode.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODES, MODE_LIST, modeOf, stepsOf, type ModeId } from '../src/modes';
import { intensityAt, stepNotes, stepTime } from '../src/chart';
import { Rhythm } from '../src/game';
import { createRounds, type RoundInfo } from '../src/engine/rematch';
import { Bus, mockNet } from './support/bus';

/** Notes per second over a whole track, averaged across seeds. */
function noteRate(m: (typeof MODE_LIST)[number], from = 0, to = Infinity, seeds = 12): number {
  let notes = 0;
  let secs = 0;
  for (let s = 0; s < seeds; s++) {
    for (let i = 0; i < stepsOf(m); i++) {
      const t = stepTime(i);
      if (t < from || t >= Math.min(to, m.lengthSec)) continue;
      const n = stepNotes(`seed${s}`, i, m.shape);
      notes += (n.left ? 1 : 0) + (n.right ? 1 : 0);
    }
    secs += Math.min(to, m.lengthSec) - from;
  }
  return notes / secs;
}

/**
 * Play a whole track without ever missing. This is the ceiling: whatever a real
 * player manages, they cannot do better than this, so if THIS cannot finish the
 * track, nobody can and the mode is a lie.
 */
function perfectRun(mode: (typeof MODE_LIST)[number], seed: string) {
  const r = new Rhythm({
    seed,
    ownLanes: [0, 1],
    authoritative: true,
    shape: mode.shape,
    steps: stepsOf(mode),
    leadSec: mode.leadSec,
  });
  // 20ms steps: shorter than the good window, so no note can slip past un-hit
  // between two ticks and the run is genuinely miss-free.
  for (let t = 0; t <= mode.lengthSec + 1 && !r.getState().over; t += 0.02) {
    r.update(t);
    for (const n of r.notes) if (!n.judged && Math.abs(t - n.time) <= 0.01) r.hit(n.lane, n.time);
  }
  return r.getState();
}

describe('modeOf', () => {
  it('resolves a known id', () => {
    expect(modeOf('overdrive').lengthSec).toBe(210);
    expect(modeOf('warmup').leadSec).toBe(2);
  });

  it('falls back rather than handing the chart an undefined shape', () => {
    // A start from an older peer, a corrupted store, or a hand-edited message.
    // Without the fallback this becomes stepsFor(undefined) -> a NaN-step track
    // that spawns nothing and can never end, so a mismatched peer sits on a dead
    // field instead of playing Relay.
    for (const bad of [undefined, null, '', 'nope', 42, {}, 'blitz']) {
      const m = modeOf(bad as unknown);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(stepsOf(m))).toBe(true);
      expect(Number.isFinite(m.leadSec)).toBe(true);
      expect(Number.isFinite(m.shape.density)).toBe(true);
    }
  });

  it('resolves a hostile id off the wire without inheriting from Object', () => {
    // MODES is an object literal, so 'constructor' / 'toString' are truthy on it.
    // Returning one of those as a Mode would put `undefined` in every field —
    // the exact dead track the fallback above exists to prevent, reached through
    // the one input it exists to distrust.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const m = modeOf(bad);
      expect(m.id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(stepsOf(m))).toBe(true);
      expect(Number.isFinite(m.shape.density)).toBe(true);
    }
  });
});

describe('the modes are actually different games', () => {
  it('offers a real spread of length, fall speed and density', () => {
    // Every knob differs on every mode. Two modes that agreed on all three would
    // be the same mode with two names.
    for (const key of ['lengthSec', 'leadSec'] as const) {
      expect(new Set(MODE_LIST.map((m) => m[key])).size, key).toBe(MODE_LIST.length);
    }
    expect(new Set(MODE_LIST.map((m) => m.shape.density)).size).toBe(MODE_LIST.length);
  });

  it('makes each track measurably busier than the last', () => {
    const rates = MODE_LIST.map((m) => noteRate(m));
    expect(rates[0]).toBeLessThan(rates[1]);
    expect(rates[1]).toBeLessThan(rates[2]);
    // Not a rounding difference: a mode has to be felt, not detected.
    expect(rates[2]).toBeGreaterThan(rates[0] * 2);
  });

  it('keeps Warm-Up a one-lane-at-a-time relay — never a two-lane chord', () => {
    // The chord rule needs intensity > 0.45 and Warm-Up's ceil is 0.45, so it is
    // structurally impossible rather than merely unlikely. That IS the mode: a
    // beginner never has to hit two lanes at once.
    expect(intensityAt(1e6, MODES.warmup.shape)).toBeLessThanOrEqual(0.45);
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < stepsOf(MODES.warmup); i++) {
        const n = stepNotes(`chord${s}`, i, MODES.warmup.shape);
        expect(n.left && n.right).toBe(false);
      }
    }
  });

  it('gives Overdrive no build — it opens busier than Relay does', () => {
    // The whole pitch of Overdrive is that there is no gentle first minute. If
    // its opening were as sparse as Relay's, it would just be "Relay but longer".
    expect(noteRate(MODES.overdrive, 0, 20)).toBeGreaterThan(noteRate(MODES.relay, 0, 20) * 1.5);
    // And its first twenty seconds — count-in included — already run at about
    // three-quarters of the rate Relay only reaches in its closing bars.
    expect(noteRate(MODES.overdrive, 0, 20)).toBeGreaterThan(
      noteRate(MODES.relay, MODES.relay.lengthSec - 20) * 0.7,
    );
  });

  it('gives Relay the build Overdrive does not have', () => {
    expect(noteRate(MODES.relay, MODES.relay.lengthSec - 20)).toBeGreaterThan(
      noteRate(MODES.relay, 0, 20) * 1.5,
    );
  });
});

describe('every mode is viable', () => {
  it('can be cleared — a miss-free run reaches the end of every track', () => {
    for (const m of MODE_LIST) {
      const s = perfectRun(m, 'viable');
      expect(s.completed, `${m.id} completed`).toBe(true);
      expect(s.miss, `${m.id} misses`).toBe(0);
      expect(s.energy, `${m.id} energy`).toBeGreaterThan(0);
      // And the track is worth playing: a mode that ends before it has handed
      // you a hundred notes is a menu item, not a game.
      expect(s.perfect, `${m.id} notes`).toBeGreaterThan(100);
    }
  });

  it('generates the whole of its longest track far inside one frame', () => {
    // Notes are generated from inside the sim's spawn loop, so this cost is paid
    // during play. Measure it rather than assume — Overdrive is 1680 steps and
    // each one seeds its own RNG.
    for (const m of MODE_LIST) {
      for (let i = 0; i < stepsOf(m); i++) stepNotes('warm', i, m.shape); // warm
      const t0 = performance.now();
      for (let i = 0; i < stepsOf(m); i++) stepNotes('perf', i, m.shape);
      expect(performance.now() - t0, `${m.id} full-track chart`).toBeLessThan(16);
    }
  });
});

describe('the sim plays the mode it was given', () => {
  /**
   * Every note the sim EVER spawned up to `until`. Sampling r.notes once at the
   * end would count almost nothing: an un-hit note is judged a miss and pruned
   * within a second, so the live array only ever holds the last breath of the
   * track.
   */
  function simNotes(mode: (typeof MODE_LIST)[number], seed: string, until: number) {
    const r = new Rhythm({
      seed,
      ownLanes: [0, 1],
      authoritative: false, // spawn and look; never judge, never end
      shape: mode.shape,
      steps: stepsOf(mode),
      leadSec: mode.leadSec,
    });
    const seen = new Map<number, { step: number; lane: 0 | 1 }>();
    for (let t = 0; t <= until; t += 0.05) {
      r.update(t);
      for (const n of r.notes) if (!seen.has(n.id)) seen.set(n.id, { step: n.step, lane: n.lane });
    }
    return [...seen.values()];
  }

  it('spawns exactly the chart its shape describes', () => {
    // Without this, `shape` could be accepted and quietly dropped: every mode
    // would play the identical default chart, both peers would agree, co-op
    // would sync — and the three tracks on the menu would be a lie nothing
    // catches.
    for (const m of MODE_LIST) {
      const notes = simNotes(m, 'sim', 25);
      expect(notes.length, `${m.id} spawned nothing`).toBeGreaterThan(0);
      for (const n of notes) {
        const want = stepNotes('sim', n.step, m.shape);
        expect(n.lane === 0 ? want.left : want.right, `${m.id} step ${n.step}`).toBe(true);
      }
    }
  });

  it('spawns a different chart per mode from the very same seed', () => {
    const warm = simNotes(MODES.warmup, 'sameseed', 25).length;
    const over = simNotes(MODES.overdrive, 'sameseed', 25).length;
    expect(over).toBeGreaterThan(warm * 1.5);
  });
});

describe('the track ends', () => {
  it('ends by completion, not by failure, when the last note is played', () => {
    const s = perfectRun(MODES.warmup, 'ending');
    expect(s.over).toBe(true);
    expect(s.completed).toBe(true);
  });

  it('does not count running out of energy as clearing the track', () => {
    const r = new Rhythm({
      seed: 'drain',
      ownLanes: [0, 1],
      authoritative: true,
      shape: MODES.relay.shape,
      steps: stepsOf(MODES.relay),
      leadSec: MODES.relay.leadSec,
    });
    r.update(60); // jump ahead: every note in between passes un-hit
    expect(r.getState().over).toBe(true);
    expect(r.getState().completed).toBe(false);
  });

  it('spawns nothing past the end of the track', () => {
    const m = MODES.warmup;
    const r = new Rhythm({
      seed: 'past',
      ownLanes: [0, 1],
      authoritative: true,
      shape: m.shape,
      steps: stepsOf(m),
      leadSec: m.leadSec,
    });
    r.update(m.lengthSec * 3);
    expect(r.notes.every((n) => n.step < stepsOf(m))).toBe(true);
  });
});

/** Two peers in a settled room, each with its own local mode pick. */
function pair(picks: Record<string, ModeId>) {
  const bus = new Bus();
  return Object.entries(picks).map(([id, pick]) => {
    const seat = {
      id,
      pick,
      got: [] as RoundInfo[],
      rounds: null as unknown as ReturnType<typeof createRounds>,
    };
    seat.rounds = createRounds({
      net: mockNet(bus, id),
      playerName: id.toUpperCase(),
      minPlayers: 2,
      // Exactly what main.ts passes.
      roundOpts: () => ({ mode: seat.pick, pub: false }),
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

describe("the host's pick is what the room plays", () => {
  it('starts both peers on the HOST\'s track, not their own', () => {
    // 'a' sorts first, so 'a' is the host. Both peers disagree about the mode
    // and only one of them gets to be right.
    const [host, guest] = pair({ a: 'warmup', b: 'overdrive' });
    host.rounds.vote();
    guest.rounds.vote();

    for (const seat of [host, guest]) {
      const opts = seat.got[0].opts as { mode: ModeId };
      expect(opts.mode, seat.id).toBe('warmup');
      // The bytes are the same, so the derived chart is too — which is the whole
      // point: a hit reported as "step 412" means the same note to both.
      expect(modeOf(opts.mode).shape).toEqual(MODES.warmup.shape);
      expect(stepsOf(modeOf(opts.mode))).toBe(stepsOf(MODES.warmup));
    }
  });

  it('re-reads the host\'s pick at start, so a change before Start counts', () => {
    const [host, guest] = pair({ a: 'warmup', b: 'relay' });
    host.pick = 'overdrive'; // host taps a different chip in the lobby
    host.rounds.vote();
    guest.rounds.vote();
    expect((guest.got[0].opts as { mode: ModeId }).mode).toBe('overdrive');
  });

  it('gossips the host\'s pick to the lobby before any round starts', () => {
    // The guest's lobby renders state().hostOpts. Rendering its OWN pick and
    // labelling it the host's would be a confident lie.
    const [host, guest] = pair({ a: 'overdrive', b: 'warmup' });
    expect((guest.rounds.state().hostOpts as { mode: ModeId }).mode).toBe('overdrive');
    expect((host.rounds.state().hostOpts as { mode: ModeId }).mode).toBe('overdrive');
  });

  it('falls back rather than crashing when the host sends a mode we do not know', () => {
    // A host on a newer build with a fourth track. The guest must play SOMETHING
    // playable rather than hand the sim an undefined shape.
    const [host, guest] = pair({ a: 'relay', b: 'relay' });
    (host as { pick: ModeId }).pick = 'megamix' as ModeId;
    host.rounds.vote();
    guest.rounds.vote();
    const m = modeOf((guest.got[0].opts as { mode: unknown }).mode);
    expect(m.id).toBe(DEFAULT_MODE);
    expect(Number.isInteger(stepsOf(m))).toBe(true);
  });
});
