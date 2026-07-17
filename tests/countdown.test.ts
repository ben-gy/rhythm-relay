/**
 * countdown.test.ts — the three seconds between the host's start and the first
 * note.
 *
 * In a rhythm game this is not decoration. The field starts scrolling the
 * instant the run begins, so without it whoever happened to be looking at the
 * screen when the start arrived gets a free head start on a shared combo. And
 * because players watch the lanes rather than the overlay, the AUDIO is the
 * countdown — the pips are what actually starts the run for them.
 *
 * The one that bites: it must be cancellable. A countdown left running fires
 * onDone over whatever screen replaced it, starting a clock, a loop and a groove
 * for a run nobody is in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountdown } from '../src/countdown';
import type { Sfx, SfxName } from '../src/engine/sound';

function fakeSfx(): Sfx & { played: SfxName[] } {
  const played: SfxName[] = [];
  return {
    played,
    unlock() {},
    play(name) {
      played.push(name);
    },
    muted: () => false,
    setMuted() {},
  };
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('createCountdown', () => {
  it('counts 3-2-1 then Go, one second apart', () => {
    const sfx = fakeSfx();
    createCountdown({ root, sfx, onDone: () => {} });
    const text = () => root.querySelector('.count-n')?.textContent;

    expect(text()).toBe('3');
    vi.advanceTimersByTime(1000);
    expect(text()).toBe('2');
    vi.advanceTimersByTime(1000);
    expect(text()).toBe('1');
    vi.advanceTimersByTime(1000);
    expect(text()).toBe('Go!');
  });

  it('sounds every tick, because nobody is looking at the number', () => {
    const sfx = fakeSfx();
    createCountdown({ root, sfx, onDone: () => {} });
    vi.advanceTimersByTime(3000);
    // Three ticks on the same frame as the digits, and a distinct Go.
    expect(sfx.played).toEqual(['blip', 'blip', 'blip', 'win']);
  });

  it('does not start the run until the count is finished', () => {
    const onDone = vi.fn();
    createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(2999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 'Go!' paints — still not playing
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('takes itself off the screen once it is done', () => {
    createCountdown({ root, sfx: fakeSfx(), onDone: () => {} });
    expect(root.querySelector('.countdown')).toBeTruthy();
    vi.advanceTimersByTime(3450);
    expect(root.querySelector('.countdown')).toBeNull();
  });

  it('cancels: no onDone, no further pips, nothing left on screen', () => {
    const sfx = fakeSfx();
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx, onDone });
    vi.advanceTimersByTime(1000);
    cd.cancel();
    // The trap: without this, a torn-down run's countdown reaches Go anyway and
    // starts a clock, a loop and a groove behind whatever screen is now up.
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
    expect(sfx.played).toEqual(['blip', 'blip']);
    expect(root.querySelector('.countdown')).toBeNull();
  });

  it('cancels during Go — the last 450ms are still not a committed run', () => {
    // The narrow one, and the only window where cancelling actually needs the
    // timer cleared: once 'Go!' is painted, the pending callback calls onDone
    // unconditionally. A peer that leaves in that half-second would otherwise
    // start a whole run — clock, loop and groove — behind the lobby it just
    // returned to.
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(3000); // 'Go!' is on screen, onDone is 450ms away
    cd.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('is safe to cancel twice, and after it has finished on its own', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(3450);
    expect(onDone).toHaveBeenCalledTimes(1);
    cd.cancel();
    cd.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('announces itself to a screen reader', () => {
    createCountdown({ root, sfx: fakeSfx(), onDone: () => {} });
    const el = root.querySelector('.countdown')!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  it('flags reduced motion so the digits do not pop', () => {
    createCountdown({ root, sfx: fakeSfx(), reducedMotion: true, onDone: () => {} });
    expect(root.querySelector('.countdown')!.classList.contains('reduced')).toBe(true);
  });

  it('counts from wherever it is told', () => {
    createCountdown({ root, sfx: fakeSfx(), from: 5, onDone: () => {} });
    expect(root.querySelector('.count-n')!.textContent).toBe('5');
  });
});
