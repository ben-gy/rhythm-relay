/**
 * noticeboard.test.ts — the serverless public-room list.
 *
 * Hosts advertise into one well-known room; browsers listen. There is no server
 * to hold the list, so the interesting behaviour is all in what happens when an
 * advertiser goes quiet, and in refusing to trust what peers say about rooms
 * that are not theirs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Noticeboard, PublicRoom } from '../src/engine/noticeboard';

interface Chan {
  handlers: Map<string, (d: unknown, from: string) => void>;
}
const wire = new Map<string, Chan>();

vi.mock('../src/engine/net', () => ({
  createNet: () => {
    // Each board instance is a separate "browser" with its own peer id.
    const self = `peer-${wire.size}`;
    const chan: Chan = { handlers: new Map() };
    wire.set(self, chan);
    return {
      selfId: self,
      peers: () => [...wire.keys()],
      host: () => [...wire.keys()][0],
      isHost: () => [...wire.keys()][0] === self,
      hostSettled: () => true,
      count: () => wire.size,
      channel<T>(name: string, onReceive: (d: T, from: string) => void) {
        chan.handlers.set(name, onReceive as (d: unknown, from: string) => void);
        const send = ((data: T, to?: string | string[]) => {
          const targets = to ? (Array.isArray(to) ? to : [to]) : [...wire.keys()].filter((p) => p !== self);
          for (const t of targets) wire.get(t)?.handlers.get(name)?.(data, self);
        }) as ((d: T, to?: string | string[]) => void) & { off: () => void };
        send.off = () => chan.handlers.delete(name);
        return send;
      },
      ping: async () => 0,
      leave: async () => {
        wire.delete(self);
      },
    };
  },
}));

const { createNoticeboard } = await import('../src/engine/noticeboard');

function board(onRooms: (r: PublicRoom[]) => void = () => {}): Noticeboard {
  return createNoticeboard({ appId: 'test', onRooms });
}

const AD = { code: 'ABCD', host: 'Ann', players: 1, max: 6, playing: false };

beforeEach(() => {
  wire.clear();
  vi.useRealTimers();
  vi.useFakeTimers();
});

describe('noticeboard', () => {
  it('shows a room only once its host advertises', () => {
    const browser = board();
    const host = board();
    expect(browser.rooms()).toEqual([]);

    host.announce(AD);
    expect(browser.rooms().map((r) => r.code)).toEqual(['ABCD']);
    expect(browser.rooms()[0].host).toBe('Ann');
  });

  it('drops a room that goes quiet, so a closed tab cannot leave a ghost', () => {
    const browser = board();
    const host = board();
    host.announce(AD);
    expect(browser.rooms()).toHaveLength(1);

    // Silence IS the withdrawal — it is the only signal that also covers a
    // crashed tab or a dead network, where no "goodbye" would ever arrive.
    host.unannounce();
    vi.advanceTimersByTime(7500);
    expect(browser.rooms()).toEqual([]);
  });

  it('keeps a room listed while it keeps advertising', () => {
    const browser = board();
    const host = board();
    host.announce(AD);
    vi.advanceTimersByTime(20_000); // the 2s re-announce keeps it fresh
    expect(browser.rooms()).toHaveLength(1);
  });

  it('refuses to let one peer overwrite another peer\'s listing', () => {
    const browser = board();
    const ann = board();
    const mallory = board();
    ann.announce(AD);
    // Same code, different sender. Keying on the CODE would let anyone hijack or
    // evict a listing they do not own.
    mallory.announce({ ...AD, host: 'Mallory', players: 99 });

    const rooms = browser.rooms();
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => r.host).sort()).toEqual(['Ann', 'Mallory']);
  });

  it('answers a newcomer immediately rather than making it wait a cycle', () => {
    const host = board();
    host.announce(AD);
    // The newcomer pings on construction; the host replies directly.
    const late = board();
    expect(late.rooms().map((r) => r.code)).toEqual(['ABCD']);
  });

  it('reports a started room so a browser does not join mid-round', () => {
    const browser = board();
    const host = board();
    host.announce({ ...AD, playing: true });
    expect(browser.rooms()[0].playing).toBe(true);
  });

  it('only notifies on a real change', () => {
    const onRooms = vi.fn();
    const browser = board(onRooms);
    const host = board();
    host.announce(AD);
    onRooms.mockClear();

    // Re-announcing the same state must not repaint the list every 2s.
    vi.advanceTimersByTime(6000);
    expect(onRooms).not.toHaveBeenCalled();

    host.announce({ ...AD, players: 2 });
    expect(onRooms).toHaveBeenCalled();
    void browser;
  });

  it('gives up rather than meshing with a crowd', () => {
    const b = board();
    expect(b.crowded()).toBe(false);
    // Trystero builds a full mesh, so N browsers is N^2 connections.
    for (let i = 0; i < 30; i++) board();
    expect(b.crowded()).toBe(true);
  });
});
