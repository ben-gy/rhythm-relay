/**
 * net-game.ts — co-op glue over patterns/net.ts.
 *
 * Model: host-authoritative. Each peer judges its OWN lane locally (so latency
 * never touches timing) and the client reports hits to the host on `hit`; the
 * host aggregates all hits into the shared state and broadcasts a compact
 * `snap` at 15Hz. Everything here is tiny and JSON-safe.
 */

import type { Net } from './engine/net';
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
  /** Recent hit-line flashes as lane*4 + resultCode, for remote feedback. */
  fl: number[];
}

const JUDGE_CODE: Record<Judge, 0 | 1 | 2> = { perfect: 0, good: 1, miss: 2 };
const CODE_JUDGE: Judge[] = ['perfect', 'good', 'miss'];

export function judgeToCode(j: Judge): 0 | 1 | 2 {
  return JUDGE_CODE[j];
}
export function codeToJudge(c: number): Judge {
  return CODE_JUDGE[c] ?? 'good';
}

/** Encode shared state (+ flashes) into a wire snapshot. */
export function packSnap(s: GameState, flashes: number[]): Snapshot {
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
    fl: flashes,
  };
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
  };
}

/** Encode a (lane,result) flash into the fl[] wire code. */
export function flashCode(lane: Lane, result: Judge): number {
  return lane * 4 + JUDGE_CODE[result];
}
export function decodeFlash(code: number): { lane: Lane; result: Judge } {
  return { lane: (code >= 4 ? 1 : 0) as Lane, result: codeToJudge(code % 4) };
}

export interface CoopCallbacks {
  /** Host: a client reported a hit on its lane. */
  onRemoteHit?: (lane: Lane, step: number, result: Judge) => void;
  /** Client: a fresh snapshot arrived from the host. */
  onSnapshot?: (state: GameState, flashes: { lane: Lane; result: Judge }[]) => void;
}

export interface Coop {
  sendHit(lane: Lane, step: number, result: Judge): void;
  broadcast(state: GameState, flashes: number[]): void;
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
    cb.onSnapshot?.(unpackSnap(snap), snap.fl.map(decodeFlash));
  });

  return {
    sendHit(lane, step, result) {
      // Client → host only.
      const host = net.host();
      sendHitRaw({ s: step, l: lane, r: JUDGE_CODE[result] }, host);
    },
    broadcast(state, flashes) {
      sendSnapRaw(packSnap(state, flashes));
    },
    destroy() {
      sendHitRaw.off();
      sendSnapRaw.off();
    },
  };
}
