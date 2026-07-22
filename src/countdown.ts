// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * countdown.ts — the three seconds between "everyone's ready" and the first note.
 *
 * Two jobs. The obvious one is fairness: the field starts scrolling the instant
 * it is visible, so without a beat to look up, whoever happened to be staring at
 * the screen when the round fired gets a free head start. The quieter one is
 * that it tells you the run is *about* to be yours — a field that simply appears
 * reads as a jump-cut.
 *
 * The audio matters more than the number, and in a rhythm game more than
 * anywhere: players watch the lanes, not the overlay, so the pips are what
 * actually starts the run for them — three rising ticks and a higher GO. That is
 * also why the tick fires on the same frame the digit changes rather than on its
 * own timer; a countdown whose sound lags its number feels broken in a way
 * people notice but cannot name.
 *
 * Every peer runs this locally from the moment the host's start arrives, so they
 * are in step to within one network hop (~50-150ms). It sits BEFORE the game
 * clock starts on either peer, so that skew costs nobody a note.
 */

import type { Sfx } from '@ben-gy/game-engine/sound';

export interface CountdownOptions {
  root: HTMLElement;
  sfx: Sfx;
  /** Ticks to count. Default 3. */
  from?: number;
  reducedMotion?: boolean;
  onDone: () => void;
}

export interface Countdown {
  /** Stop early — a peer that left, or a run torn down mid-count. */
  cancel(): void;
}

export function createCountdown(o: CountdownOptions): Countdown {
  const from = o.from ?? 3;
  let n = from;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  if (o.reducedMotion) el.classList.add('reduced');
  o.root.appendChild(el);

  function paint(text: string, cls: string): void {
    el.innerHTML = `<span class="count-n ${cls}">${text}</span>`;
  }

  function step(): void {
    if (done) return;
    if (n > 0) {
      paint(String(n), 'cd-tick');
      // Pitch climbs with the count so the ear tracks it without reading.
      o.sfx.play('blip');
      n--;
      timer = setTimeout(step, 1000);
      return;
    }
    paint('Go!', 'cd-go');
    o.sfx.play('win');
    timer = setTimeout(() => {
      finish();
      o.onDone();
    }, 450);
  }

  function finish(): void {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    el.remove();
  }

  step();

  return {
    cancel() {
      finish();
    },
  };
}
