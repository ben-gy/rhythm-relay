/**
 * net.ts — zero-backend P2P networking for browser games (Trystero/WebRTC).
 * Copied from patterns/. Host-authoritative star: min-peer-id election, typed
 * channels, latency ping, automatic host re-election on leave.
 */

// Default = nostr strategy. Switch to 'trystero/torrent' if relays are flaky.
import { joinRoom, selfId } from 'trystero';

export type PeerId = string;
export type NetData = unknown;

export interface NetConfig {
  appId: string;
  roomId: string;
  password?: string;
}

export interface NetHandlers {
  onPeerJoin?: (id: PeerId) => void;
  onPeerLeave?: (id: PeerId) => void;
  onPeers?: (peers: PeerId[], selfId: PeerId) => void;
  onHostChange?: (hostId: PeerId, isSelfHost: boolean) => void;
}

export interface Net {
  readonly selfId: PeerId;
  peers(): PeerId[];
  host(): PeerId;
  isHost(): boolean;
  count(): number;
  channel<T = NetData>(
    name: string,
    onReceive: (data: T, from: PeerId) => void,
  ): (data: T, toPeers?: PeerId | PeerId[]) => void;
  ping(id: PeerId): Promise<number>;
  leave(): void;
}

function electHost(peers: PeerId[]): PeerId {
  return peers.reduce((min, p) => (p < min ? p : min), peers[0]);
}

export function createNet(config: NetConfig, handlers: NetHandlers = {}): Net {
  const room = joinRoom(
    { appId: config.appId, ...(config.password ? { password: config.password } : {}) },
    config.roomId,
  );

  const sends = new Map<string, (d: NetData, to?: PeerId | PeerId[]) => void>();
  let currentHost: PeerId = selfId;

  const roster = (): PeerId[] => [selfId, ...Object.keys(room.getPeers())].sort();

  function recomputeHost(): void {
    const next = electHost(roster());
    if (next !== currentHost) {
      currentHost = next;
      handlers.onHostChange?.(currentHost, currentHost === selfId);
    }
  }

  handlers.onHostChange?.(currentHost, true);

  room.onPeerJoin((id) => {
    handlers.onPeerJoin?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  room.onPeerLeave((id) => {
    handlers.onPeerLeave?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  const pending = new Map<string, (rtt: number) => void>();
  const [sendPing, getPing] = room.makeAction<{ t: number; id: string; pong?: boolean }>('ping');
  getPing((msg, from) => {
    if (msg.pong) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(performance.now() - msg.t);
      }
    } else {
      sendPing({ ...msg, pong: true }, from);
    }
  });

  return {
    selfId,
    peers: roster,
    host: () => currentHost,
    isHost: () => currentHost === selfId,
    count: () => roster().length,

    channel<T = NetData>(name: string, onReceive: (data: T, from: PeerId) => void) {
      if (name.length > 12) {
        throw new Error(`net channel "${name}" exceeds 12 bytes`);
      }
      const existing = sends.get(name);
      if (existing) return existing as (d: T, to?: PeerId | PeerId[]) => void;
      // Trystero constrains payloads to its DataPayload type; our channels are
      // JSON-safe game messages, so bypass the structural check with a cast.
      const [send, get] = (room.makeAction as unknown as (
        n: string,
      ) => [
        (d: T, to?: PeerId | PeerId[]) => void,
        (cb: (data: T, from: PeerId) => void) => void,
      ])(name);
      get((data, from) => onReceive(data, from));
      sends.set(name, send as (d: NetData, to?: PeerId | PeerId[]) => void);
      return send as (d: T, to?: PeerId | PeerId[]) => void;
    },

    ping(id: PeerId) {
      return new Promise<number>((resolve) => {
        const pid = `${performance.now()}-${Math.floor(Math.random() * 1e6)}`;
        pending.set(pid, resolve);
        sendPing({ t: performance.now(), id: pid }, id);
        setTimeout(() => {
          if (pending.delete(pid)) resolve(Infinity);
        }, 5000);
      });
    },

    leave() {
      room.leave();
      sends.clear();
      pending.clear();
    },
  };
}

export { selfId };
