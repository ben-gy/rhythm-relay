/**
 * The HUD's bail-out affordance differs by mode, and it is not cosmetic.
 *
 * A co-op run cannot be paused: the partner's sim keeps running whatever this
 * player does, so freezing our own authoritative sim while still broadcasting
 * over=false is exactly how a run becomes unfinishable for both. Co-op therefore
 * gets Leave (which flushes over=true and returns everyone to the lobby) where
 * solo gets Pause.
 */
import { describe, expect, it } from 'vitest';
import { hudMarkup } from '../src/ui';

describe('hudMarkup', () => {
  it('offers Pause in solo, and no way to leave a run nobody else is in', () => {
    const hud = hudMarkup(false);
    expect(hud.querySelector('[data-act="pause"]')).not.toBe(null);
    expect(hud.querySelector('[data-act="leave"]')).toBe(null);
  });

  it('offers Leave in co-op, and never Pause', () => {
    const hud = hudMarkup(true);
    expect(hud.querySelector('[data-act="leave"]')).not.toBe(null);
    expect(hud.querySelector('[data-act="pause"]')).toBe(null);
  });

  it('keeps mute in both modes', () => {
    for (const coop of [false, true]) {
      expect(hudMarkup(coop).querySelector('[data-act="mute"]')).not.toBe(null);
    }
  });
});
