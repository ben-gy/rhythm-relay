// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * net-game.ts — co-op glue over patterns/net.ts.
 *
 * Model: host-authoritative. Each peer judges its OWN lane locally (so latency
 * never touches timing) and the client reports hits to the host on `hit`; the
 * host aggregates all hits into the shared state and broadcasts a compact
 * `snap` at 15Hz. Everything here is tiny and JSON-safe.
 */

import type { Net } from '@ben-gy/game-engine/net';
import type { GameState, Judge, Lane } from './game';

/** Compact hit report: step, lane, result code. */
export interface HitMsg {
  s: number;
  l: Lane;
  r: 0 | 1 | 2; // perfect | good | miss
}

/** Compact shared-state snapshot (short keys keep the WebRTC payload small). */
export interface Snapshot {
  e: number; // energy
  c: number; // combo
  /** Best combo of the run. It is NOT derivable from `c` — a client that aliased
   *  the two showed its own results screen the combo it happened to end on. */
  maxC: number;
  x: number; // multiplier
  sc: number; // score
  p: number; // perfect
  g: number; // good
  ms: number; // miss
  o: 0 | 1; // over
  /** Finished the track, as opposed to running out of energy. Not derivable
   *  from `o`, and the two deserve opposite results screens. */
  fin: 0 | 1;
  /** Recent hit-line flashes as lane*4 + resultCode, for remote feedback. */
  fl: number[];
  /** The host's own game clock, in whole ms. This is the client's only proof
   *  that the host's sim is still alive: snapshot ARRIVAL proves nothing, since
   *  a frozen host's broadcast interval keeps re-sending an identical snapshot.
   *  See createHostWatchdog. */
  t: number;
}

const JUDGE_CODE: Record<Judge, 0 | 1 | 2> = { perfect: 0, good: 1, miss: 2 };
const CODE_JUDGE: Judge[] = ['perfect', 'good', 'miss'];

export function judgeToCode(j: Judge): 0 | 1 | 2 {
  return JUDGE_CODE[j];
}
export function codeToJudge(c: number): Judge {
  return CODE_JUDGE[c] ?? 'good';
}

/** Encode shared state (+ flashes) into a wire snapshot. `t` is host game seconds. */
export function packSnap(s: GameState, flashes: number[], t: number): Snapshot {
  return {
    e: Math.round(s.energy),
    c: s.combo,
    maxC: s.maxCombo,
    x: s.multiplier,
    sc: s.score,
    p: s.perfect,
    g: s.good,
    ms: s.miss,
    o: s.over ? 1 : 0,
    fin: s.completed ? 1 : 0,
    fl: flashes,
    t: Math.round(t * 1000),
  };
}

/** The host clock a snapshot carries, or null from a peer too old to send one. */
export function snapTime(snap: Snapshot): number | null {
  return typeof snap.t === 'number' ? snap.t : null;
}

/** Decode a wire snapshot back into a GameState. */
export function unpackSnap(snap: Snapshot): GameState {
  return {
    energy: snap.e,
    combo: snap.c,
    // A peer still running a pre-maxC build sends no maxC; fall back rather than
    // render `undefined` on its partner's results screen.
    maxCombo: snap.maxC ?? snap.c,
    multiplier: snap.x,
    score: snap.sc,
    perfect: snap.p,
    good: snap.g,
    miss: snap.ms,
    over: snap.o === 1,
    // A peer on a pre-modes build sends no `fin`. Read that as "did not finish"
    // rather than undefined: a run we cannot prove was completed was not.
    completed: snap.fin === 1,
  };
}

/** Encode a (lane,result) flash into the fl[] wire code. */
export function flashCode(lane: Lane, result: Judge): number {
  return lane * 4 + JUDGE_CODE[result];
}
export function decodeFlash(code: number): { lane: Lane; result: Judge } {
  return { lane: (code >= 4 ? 1 : 0) as Lane, result: codeToJudge(code % 4) };
}

/**
 * Wall-clock ms of host stall after which a client stops waiting for it.
 *
 * The host broadcasts at ~15Hz, and even a backgrounded host still ticks and
 * sends roughly once a second (browsers throttle setInterval to ~1s but do not
 * stop it), so five seconds of a motionless host clock means it is really gone —
 * crashed, closed, or OS-suspended — not merely slow.
 */
export const HOST_STALL_MS = 5000;

export interface HostWatchdog {
  /** Feed a snapshot's host clock (null = peer sends none). `now` is wall-clock ms. */
  feed(hostTime: number | null, now: number): void;
  /** Call every sim tick. Fires `onStall` once, when the host has gone still. */
  tick(now: number): void;
  stalled(): boolean;
}

/**
 * A client's dead-host detector.
 *
 * The client's sim is authoritative:false — it can never end a run on its own,
 * only by way of a host snapshot carrying over=true. So a host that stops
 * advancing without sending that flush leaves its partner playing a run that can
 * never finish, with no results screen and no way to vote for a rematch: the
 * whole room is held hostage by one dead tab. This is the backstop for that.
 *
 * It watches the host CLOCK rather than snapshot arrival on purpose. A host that
 * is paused, frozen, or backgrounded keeps its broadcast interval running and
 * re-sends a byte-identical over=false snapshot forever, so "a snapshot arrived
 * recently" is not evidence of a living sim. A host clock that moved is.
 */
export function createHostWatchdog(opts: {
  /** Wall-clock ms at run start — the first deadline runs from here. */
  startedAt: number;
  onStall: () => void;
  timeoutMs?: number;
}): HostWatchdog {
  const timeout = opts.timeoutMs ?? HOST_STALL_MS;
  let lastHostTime = -Infinity;
  let lastProgress = opts.startedAt;
  let fired = false;
  let disabled = false;

  return {
    feed(hostTime, now) {
      // A peer too old to report a clock gives us nothing to judge it by. Stay
      // out of its way rather than cutting short a run that is actually fine.
      if (hostTime === null) {
        disabled = true;
        return;
      }
      if (hostTime <= lastHostTime) return; // re-sent or reordered: not progress
      lastHostTime = hostTime;
      lastProgress = now;
    },
    tick(now) {
      if (fired || disabled) return;
      if (now - lastProgress < timeout) return;
      fired = true;
      opts.onStall();
    },
    stalled: () => fired,
  };
}

export interface CoopCallbacks {
  /** Host: a client reported a hit on its lane. */
  onRemoteHit?: (lane: Lane, step: number, result: Judge) => void;
  /** Client: a fresh snapshot arrived from the host. */
  onSnapshot?: (
    state: GameState,
    flashes: { lane: Lane; result: Judge }[],
    hostTime: number | null,
  ) => void;
}

export interface Coop {
  sendHit(lane: Lane, step: number, result: Judge): void;
  /** Host → clients. `t` is the host's game clock in seconds. */
  broadcast(state: GameState, flashes: number[], t: number): void;
  /**
   * Detach this run's receivers. The Net outlives a run (a rematch reuses it),
   * and net.channel() fans out — so a Coop that is never destroyed keeps
   * answering for a run that is over, feeding the NEXT run's sim twice.
   */
  destroy(): void;
}

export function createCoop(net: Net, cb: CoopCallbacks): Coop {
  const sendHitRaw = net.channel<HitMsg>('hit', (m) => {
    cb.onRemoteHit?.(m.l, m.s, codeToJudge(m.r));
  });
  const sendSnapRaw = net.channel<Snapshot>('snap', (snap) => {
    cb.onSnapshot?.(unpackSnap(snap), snap.fl.map(decodeFlash), snapTime(snap));
  });

  return {
    sendHit(lane, step, result) {
      // Client → host only. host() is null until the room settles, and passing
      // that through would drop the `to` argument and BROADCAST the hit at every
      // peer — so hold our tongue instead. A run only ever starts after the room
      // has settled, so there is no hit here worth losing.
      const host = net.host();
      if (!host) return;
      sendHitRaw({ s: step, l: lane, r: JUDGE_CODE[result] }, host);
    },
    broadcast(state, flashes, t) {
      sendSnapRaw(packSnap(state, flashes, t));
    },
    destroy() {
      sendHitRaw.off();
      sendSnapRaw.off();
    },
  };
}
