/**
 * rematch.test.ts — the multi-round protocol, driven with simulated peers.
 *
 * What this covers and what it deliberately does not:
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster (which in Rhythm Relay decides who takes which LANE), host
 *    election, host handover. A fake bus exercises that logic honestly.
 *
 *  - NOT COVERED: the transport bug that started all this. A fake bus sits ABOVE
 *    Trystero's room cache, so it structurally cannot contain that defect and
 *    would happily go green while the real game was broken. Two other tests own
 *    that: trystero-rejoin.test.ts pins the Trystero behaviour itself, and
 *    net-lifecycle.test.ts asserts the "one join per session" invariant that
 *    makes the trap unreachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type RoundPlayer } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
// The same in-memory bus modes.test.ts uses. It used to be copy-pasted here;
// with four new Net members to satisfy, one copy is the only maintainable
// number.
import { Bus, mockNet } from './support/bus';
import type { Lane } from '../src/chart';

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

function table(ids: PeerId[], opts: { minPlayers?: number } = {}): Seat[] {
  const bus = new Bus();
  return ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

/**
 * main.ts's lane rule, mirrored: a peer's lane is its index in the host's frozen
 * roster. Asserting through this function is the point — the roster is exactly
 * what stops both players grabbing lane 0 while lane 1 auto-misses on nobody.
 */
function laneOf(info: RoundInfo, selfId: PeerId): Lane | null {
  const i = info.players.findIndex((p: RoundPlayer) => p.id === selfId);
  if (i < 0) return null;
  return i === 0 ? 0 : 1;
}

let seats: Seat[];

beforeEach(() => {
  seats = [];
  // Every auto-start in this file now has to wait out a timer, so the whole file
  // runs on fake clocks rather than each test opting in.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Wait out the roster-settle window, then the poll tick that re-attempts the
 * start.
 *
 * An AUTOMATIC start no longer fires on the last vote. The host refuses to
 * freeze a roster until the roster has held still for ROSTER_SETTLE_MS (4s),
 * because a mesh that is still forming makes "everyone I can see has voted" a
 * lie — that is precisely how a joiner got left behind in a dead lobby while
 * everyone else played. maybeAutoStart() returns early inside the window and a
 * 1.5s poll retries, so the start lands within one tick of the window closing.
 *
 * Hence 6000ms: the 4s window plus the next poll. Anything that changes the
 * roster — a join, a leave — restarts the window, so call this AFTER the last
 * such event. The host's explicit go() is deliberately not gated by any of
 * this, and needs no settle.
 */
function settle(): void {
  vi.advanceTimersByTime(6000);
}

describe('createRounds — starting a co-op run', () => {
  it('starts once both players have voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Auto-start fires once the roster has been quiet, not on the last vote —
    // and still with nobody pressing Start.
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so the two players take different lanes', () => {
    seats = table(['b', 'a']);
    seats.forEach((s) => s.rounds.vote());
    settle();

    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[0]).toEqual(['a:A', 'b:B']);

    // Every peer derives its lane from the same bytes, so the lanes are disjoint
    // and cover the field — not two peers both deciding they are player 0.
    const lanes = seats.map((s) => laneOf(s.got[0], s.id));
    expect(lanes.sort()).toEqual([0, 1]);
  });

  it('waits below quorum — a lone player never starts a co-op run', () => {
    seats = table(['a', 'b']);
    seats[0].rounds.vote();
    // Not just "not yet": a whole settle window passes and one vote still is
    // not a run.
    settle();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);

    seats[1].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    // 'b' is not the host; forge a start and make sure nobody honours it.
    seats[1].net.channel('rs', () => {})(
      { round: 1, seed: 42, roster: [{ id: 'b', name: 'B' }] } as never,
    );
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second run in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Both players hit "Play again" on the results screen — the exact sequence
    // that used to leave and rejoin the room and strand them both. finish()
    // deliberately reopens the settle window, so the rematch waits it out too:
    // a room that sat on a results screen for ten minutes must not start on
    // whoever happens to be visible in the first instant.
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    // The symptom was TWO hosts. There must be exactly one, every run.
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    // …and a fresh chart, not a replay of run 1.
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it('keeps both peers in each other\'s roster across the rematch', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // "Neither can see each other" — assert the opposite, directly.
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('hands each player the SAME lane on the rematch as on the first run', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    for (const s of seats) {
      expect(laneOf(s.got[1], s.id)).toBe(laneOf(s.got[0], s.id));
    }
    expect(seats.map((s) => laneOf(s.got[1], s.id)).sort()).toEqual([0, 1]);
  });

  it('ignores a stale or duplicated start rather than restarting a live run', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    const seed = seats[0].got[0].seed;

    // Replay run 1's start — e.g. a duplicate delivery, or both peers pressing
    // at the same instant. The monotonic guard must swallow it.
    seats[0].net.channel('rs', () => {})(
      { round: 1, seed: 999, roster: [{ id: 'a', name: 'A' }] } as never,
    );
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a run is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote()); // run 1 playing; no finish()
    settle();
    seats.forEach((s) => s.rounds.vote()); // premature "play again"
    settle();
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1); // still waiting on c

    void seats[2].net.leave(); // c closes the tab
    seats[0].rounds.vote(); // any nudge re-tallies
    // A LEAVE is a roster change too, so it reopens the settle window. The host
    // must not freeze a roster on the strength of a departure it has only just
    // noticed, so the run lands one poll after the window rather than instantly.
    settle();

    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    expect(seats[0].net.isHost()).toBe(true);

    void seats[0].net.leave(); // the host walks away between runs
    expect(seats[1].net.isHost()).toBe(true); // b is promoted by min-id election

    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle(); // the host's departure reopened the settle window

    // The promoted host must be able to run the rematch — inheriting no tally
    // from the old host is the classic way this deadlocks.
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    settle();

    // A destroyed Rounds must not keep driving a screen that is gone.
    expect(seats[1].got.length).toBe(0);
  });
});

/**
 * Rhythm Relay seats two players per run, so "everyone present has voted" and
 * "quorum" coincide at a clean two-peer table — and that is exactly why the old
 * unanimity rule looked fine in testing. It breaks the moment a THIRD peer is in
 * the room, which one shared invite link is enough to do: two players tap Play
 * again, the third never does, and the old rule held the run forever with no way
 * out but the menu. Hence three seats here.
 */
describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Two of three hit "Play again". The third is still reading the summary.
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // the grace countdown only arms once the roster has gone quiet
    expect(seats[0].got.length).toBe(1); // not yet — the countdown is running

    const s = seats[0].rounds.state();
    expect(s.startsInMs).toBeGreaterThan(0); // and it is VISIBLE, not a silent hang

    vi.advanceTimersByTime(8100);

    // The two who voted get their run, and the lanes are theirs: the frozen
    // roster holds only the voters, so nobody is assigned a lane they never
    // asked for and left to auto-miss down it.
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());

    // The rematch waits out the settle window like any other start, but it must
    // NOT also be punished with the 8s grace countdown — that one exists for
    // stragglers, and here nobody is straggling. settle() is 6s, well short of
    // the 8s grace, and startsInMs being null proves no countdown was ever armed.
    settle();
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[0].rounds.go(); // the results screen's "Start now"

    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // arms the grace countdown
    expect(seats[0].rounds.state().startsInMs).toBeGreaterThan(0);

    seats[1].rounds.unvote(); // changed their mind
    expect(seats[0].rounds.state().startsInMs).toBeNull();

    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1); // no run started below quorum
  });

  it('a peer who taps mid-countdown still lands in the run', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // the countdown is now genuinely running…
    expect(seats[0].rounds.state().startsInMs).toBeGreaterThan(0);

    seats[2].rounds.vote(); // …and the straggler taps just in time

    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});
