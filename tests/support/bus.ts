/**
 * bus.ts — a synchronous in-memory stand-in for a settled P2P room.
 *
 * Delivery is immediate and lossless because these tests are about protocol
 * DECISIONS, not timing. It sits above Trystero, so it structurally cannot
 * reproduce transport bugs and must never be used to claim one is fixed —
 * trystero-rejoin.test.ts and net-lifecycle.test.ts own that ground.
 */

import type { Net, NetDiag, PeerId } from '@ben-gy/game-engine/net';

export class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** Roster watchers, per peer — backs Net.onPeersChange. */
  private watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();

  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.announceRoster();
  }

  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.announceRoster();
  }

  /** A join or a part changes the roster for EVERY peer, not just the mover. */
  private announceRoster(): void {
    const roster = this.roster();
    for (const cbs of this.watchers.values()) for (const cb of [...cbs]) cb(roster);
  }

  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    if (!this.watchers.has(id)) this.watchers.set(id, new Set());
    this.watchers.get(id)!.add(cb);
    return () => this.watchers.get(id)?.delete(cb);
  }

  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }

  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }

  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

export function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    // Same election rule as the real net.ts: lexicographically smallest id.
    host: () => bus.roster()[0],
    isHost: () => bus.roster()[0] === selfId,
    hostSettled: () => true,
    // The bus models an ALREADY-SETTLED room, so there is no term to advance and
    // nothing to take over: one fixed epoch, and takeover() is a no-op. Peers
    // arriving and leaving is real though, so onPeersChange is wired to the bus
    // rather than stubbed — rematch.ts resets its roster-settle clock from it,
    // and a stub would make every roster look permanently quiet.
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    onPeersChange: (cb) => bus.watch(selfId, cb),
    takeover: () => {},
    netDiag: (): NetDiag => ({
      selfId,
      host: bus.roster()[0] ?? null,
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}
