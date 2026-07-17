/**
 * A host that stops ticking must never strand its partner.
 *
 * Co-op is host-authoritative and the client's sim is authoritative:false, so a
 * client can only ever reach its results screen via a host snapshot carrying
 * over=true. That makes a silent host uniquely destructive: the client plays on
 * forever with no results and no way to vote for a rematch, which holds the whole
 * room hostage. Two defences, covered here:
 *
 *   1. The host keeps simulating while its tab is hidden (setInterval survives
 *      what rAF does not), so an abandoned run drains out and flushes over=true.
 *   2. If the host dies anyway — crash, close, OS suspend — the client's watchdog
 *      notices the host clock has stopped and ends the run on what it last knew.
 */
import { describe, expect, it } from 'vitest';
import { Rhythm, type GameState } from '../src/game';
import {
  HOST_STALL_MS,
  createHostWatchdog,
  packSnap,
  snapTime,
  unpackSnap,
  type Snapshot,
} from '../src/net-game';

const live: GameState = {
  energy: 80,
  combo: 5,
  maxCombo: 9,
  multiplier: 1,
  score: 500,
  perfect: 4,
  good: 1,
  miss: 1,
  over: false,
  completed: false,
};

/** A snapshot as it arrives on the wire, from a host whose clock reads `t` sec. */
function wire(t: number, state: GameState = live): Snapshot {
  return packSnap(state, [], t);
}

describe('the stranding a client cannot escape on its own', () => {
  it('a view-only client never ends its own run, however long it plays', () => {
    const client = new Rhythm({ seed: 'g', ownLanes: [1], authoritative: false });
    // Two minutes of notes going by entirely un-hit.
    for (let t = 0; t < 120; t += 0.25) client.update(t);
    // Still "alive": shared state only ever moves under a host snapshot. An
    // authoritative sim would have drained to over long ago (see game.test.ts).
    expect(client.getState().over).toBe(false);
    expect(client.getState().energy).toBe(100);
  });
});

describe('host watchdog', () => {
  it('stays quiet while the host clock keeps advancing', () => {
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (stalled = true) });
    for (let now = 0; now < 30_000; now += 66) {
      wd.feed(snapTime(wire(now / 1000)), now);
      wd.tick(now);
    }
    expect(stalled).toBe(false);
  });

  it('tolerates a backgrounded host ticking at the ~1s setInterval throttle', () => {
    // A hidden tab gets no rAF and its intervals are clamped to ~1s. That is slow,
    // not dead, and cutting the run short here would be a false positive.
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (stalled = true) });
    for (let now = 0; now < 60_000; now += 1000) {
      wd.feed(snapTime(wire(now / 1000)), now);
      wd.tick(now);
    }
    expect(stalled).toBe(false);
  });

  it('fires when the host clock freezes even though snapshots keep arriving', () => {
    // The case a "no snapshot received" watchdog cannot see. A frozen host still
    // runs its 15Hz broadcast interval, re-sending a byte-identical over=false
    // snapshot forever — so arrival is not evidence of a living sim, and only the
    // host's own clock is.
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (stalled = true) });

    let now = 0;
    for (; now < 2000; now += 66) {
      wd.feed(snapTime(wire(now / 1000)), now);
      wd.tick(now);
    }
    expect(stalled).toBe(false);

    const frozenAt = now / 1000;
    for (; now < 2000 + HOST_STALL_MS + 500; now += 66) {
      wd.feed(snapTime(wire(frozenAt)), now); // same clock, over and over
      wd.tick(now);
    }
    expect(stalled).toBe(true);
  });

  it('fires when snapshots stop arriving altogether', () => {
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (stalled = true) });
    wd.feed(snapTime(wire(1)), 1000);
    for (let now = 1000; now < 1000 + HOST_STALL_MS + 200; now += 100) wd.tick(now);
    expect(stalled).toBe(true);
  });

  it('does not treat a stale or reordered snapshot as progress', () => {
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (stalled = true) });
    wd.feed(snapTime(wire(5)), 0);
    // An older clock arriving late says nothing about the host being alive now.
    for (let now = 0; now < HOST_STALL_MS + 200; now += 100) {
      wd.feed(snapTime(wire(4.5)), now);
      wd.tick(now);
    }
    expect(stalled).toBe(true);
  });

  it('fires once, not on every tick after the deadline', () => {
    let count = 0;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => count++ });
    for (let now = 0; now < HOST_STALL_MS * 3; now += 100) wd.tick(now);
    expect(count).toBe(1);
    expect(wd.stalled()).toBe(true);
  });

  it('stands down for a peer too old to report a clock', () => {
    // Rather than cut short a run that is very likely fine, defer to the old
    // behaviour for a partner still on a build that sends no `t`.
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (stalled = true) });
    for (let now = 0; now < HOST_STALL_MS * 2; now += 100) {
      wd.feed(null, now);
      wd.tick(now);
    }
    expect(stalled).toBe(false);
  });

  it('honours a custom timeout', () => {
    let stalled = false;
    const wd = createHostWatchdog({ startedAt: 0, timeoutMs: 1000, onStall: () => (stalled = true) });
    wd.tick(999);
    expect(stalled).toBe(false);
    wd.tick(1000);
    expect(stalled).toBe(true);
  });
});

describe('host stops ticking → the client is not stranded', () => {
  it('ends the client on its last-known state instead of never', () => {
    const client = new Rhythm({ seed: 'g', ownLanes: [1], authoritative: false });
    let ended = false;
    const wd = createHostWatchdog({ startedAt: 0, onStall: () => (ended = true) });

    // Three seconds of a healthy host: 15Hz snapshots, clock advancing.
    let now = 0;
    for (; now < 3000; now += 66) {
      const snap = wire(now / 1000);
      wd.feed(snapTime(snap), now);
      client.applySnapshot(unpackSnap(snap));
      client.update(now / 1000);
      wd.tick(now);
    }
    expect(ended).toBe(false);

    // The host's tab dies mid-run. No over=true ever arrives.
    for (; now < 3000 + HOST_STALL_MS + 200; now += 100) {
      client.update(now / 1000);
      wd.tick(now);
    }

    // The client's own sim still calls the run live — it structurally cannot say
    // otherwise. The watchdog is the only thing that gets this player out.
    expect(client.getState().over).toBe(false);
    expect(ended).toBe(true);
    // And it ends on real state, so the results screen has something to show.
    expect(client.getState().score).toBe(live.score);
    expect(client.getState().maxCombo).toBe(live.maxCombo);
  });
});

describe('a backgrounded co-op host still finishes its run', () => {
  it('drains to over=true on a throttled ~1s tick, giving the client its flush', () => {
    // What simTick does in co-op: no rAF at all, one interval tick a second, and
    // no absorbing the gap as paused time (that is solo-only). The abandoned lanes
    // miss honestly, energy drains, and the run reaches an end the host can flush.
    const host = new Rhythm({ seed: 'g', ownLanes: [0], authoritative: true });
    let t = 0;
    for (; t < 120 && !host.getState().over; t += 1) host.update(t);
    expect(host.getState().over).toBe(true);
    expect(host.getState().energy).toBe(0);

    // That end is what reaches the partner, and it survives the wire intact.
    const flush = unpackSnap(packSnap(host.getState(), [], t));
    expect(flush.over).toBe(true);
  });

  it('would freeze forever if the co-op clock absorbed the gap as paused time', () => {
    // Guards the solo-only condition on simTick's frame-gap absorption. If co-op
    // took that branch, every throttled tick would rewind the clock by exactly the
    // time that had passed, pinning the sim here and never ending the run.
    const host = new Rhythm({ seed: 'g', ownLanes: [0], authoritative: true });
    const pinned = 2.0;
    for (let i = 0; i < 120; i++) host.update(pinned); // clock never moves
    expect(host.getState().over).toBe(false);
  });
});
