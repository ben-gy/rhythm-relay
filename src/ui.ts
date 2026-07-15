/**
 * ui.ts — DOM screens and HUD chrome. Semantic markup, ARIA on controls.
 * The animated playfield is Canvas (render.ts); everything static is here.
 */

import type { GameState } from './game';

export const FOOTER_HTML = `
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;

function el(html: string): HTMLElement {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild as HTMLElement;
}

function muteIcon(muted: boolean): string {
  return muted ? '🔇' : '🔊';
}

export interface MenuHandlers {
  best: number;
  muted: boolean;
  onSolo: () => void;
  onCoop: () => void;
  onHowTo: () => void;
  onAbout: () => void;
  onToggleMute: () => void;
}

export function screenMenu(h: MenuHandlers): HTMLElement {
  const root = el(`
    <section class="screen menu" aria-label="Main menu">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <span class="bar l"></span><span class="bar r"></span>
        </div>
        <h1 class="brand-title">Rhythm <span>Relay</span></h1>
        <p class="brand-tag">Relay the beat left to right. Keep the combo alive.</p>
      </div>
      <div class="menu-actions">
        <button class="btn primary" data-act="solo">▶ Play</button>
        <button class="btn" data-act="coop">👥 Play with a friend</button>
        <div class="menu-row">
          <button class="btn ghost" data-act="how">How to play</button>
          <button class="btn ghost" data-act="about">About</button>
        </div>
      </div>
      <p class="menu-best">${h.best > 0 ? `Best score <strong>${h.best.toLocaleString()}</strong>` : 'Set your first score!'}</p>
      <button class="icon-btn mute" data-act="mute" aria-label="Toggle sound">${muteIcon(h.muted)}</button>
    </section>`);
  root.querySelector('[data-act="solo"]')!.addEventListener('click', h.onSolo);
  root.querySelector('[data-act="coop"]')!.addEventListener('click', h.onCoop);
  root.querySelector('[data-act="how"]')!.addEventListener('click', h.onHowTo);
  root.querySelector('[data-act="about"]')!.addEventListener('click', h.onAbout);
  const mute = root.querySelector<HTMLButtonElement>('[data-act="mute"]')!;
  mute.addEventListener('click', () => {
    h.onToggleMute();
    mute.textContent = muteIcon(h.muted);
  });
  return root;
}

export function screenHowTo(onBack: () => void): HTMLElement {
  const root = el(`
    <section class="screen sheet" aria-label="How to play">
      <h2>How to play</h2>
      <ol class="how-list">
        <li>Notes fall down <strong>two lanes</strong> toward the glowing line.</li>
        <li>Tap <strong class="c-left">left</strong> (<kbd>F</kbd> / <kbd>←</kbd>) the instant a left note reaches the line, <strong class="c-right">right</strong> (<kbd>J</kbd> / <kbd>→</kbd>) for a right note. On a phone, tap the <strong>left or right half</strong> of the screen.</li>
        <li>Clean hits build your <strong>combo</strong> and score multiplier. Misses drain your <strong>energy</strong> — empty and the run ends.</li>
        <li>The track keeps speeding up. Stay in the pocket.</li>
      </ol>
      <p class="how-note">Playing with a friend? You each take one lane over a shared link — the combo is <em>shared</em>, so keep it together.</p>
      <button class="btn primary" data-act="back">Got it</button>
    </section>`);
  root.querySelector('[data-act="back"]')!.addEventListener('click', onBack);
  return root;
}

export function screenAbout(onBack: () => void): HTMLElement {
  const root = el(`
    <section class="screen sheet" aria-label="About">
      <h2>About</h2>
      <p><strong>Rhythm Relay</strong> is a two-lane rhythm game. The music and every falling note are generated on the fly — no audio files, no downloads. Play solo, or take a lane each with a friend.</p>
      <p class="dim">Co-op is <strong>peer-to-peer</strong>: your browsers connect directly. A free public signalling relay only helps make that first handshake — no game data is stored on any server of ours.</p>
      <p class="dim">No cookies, no fingerprinting, no third-party fonts. The only analytics is Cloudflare's cookie-less, anonymous page-view count.</p>
      <button class="btn primary" data-act="back">Back</button>
    </section>`);
  root.querySelector('[data-act="back"]')!.addEventListener('click', onBack);
  return root;
}

export function hudMarkup(coop: boolean): HTMLElement {
  return el(`
    <div class="hud" role="group" aria-label="Game status">
      <div class="hud-left">
        <button class="icon-btn" data-act="pause" aria-label="Pause">⏸</button>
        <button class="icon-btn" data-act="mute" aria-label="Toggle sound">🔊</button>
      </div>
      <div class="hud-energy" aria-label="Energy">
        <div class="energy-fill"></div>
        ${coop ? '<span class="hud-coop">CO-OP</span>' : ''}
      </div>
      <div class="hud-right">
        <div class="hud-score" aria-live="off"><span class="score-val">0</span></div>
        <div class="hud-best">best ${'0'}</div>
      </div>
    </div>`);
}

export function updateHud(hud: HTMLElement, state: GameState, best: number, muted: boolean): void {
  const fill = hud.querySelector<HTMLElement>('.energy-fill')!;
  const pct = Math.max(0, Math.min(100, state.energy));
  fill.style.width = `${pct}%`;
  fill.classList.toggle('low', pct <= 30);
  hud.querySelector('.score-val')!.textContent = state.score.toLocaleString();
  hud.querySelector('.hud-best')!.textContent = `best ${Math.max(best, state.score).toLocaleString()}`;
  const mute = hud.querySelector<HTMLButtonElement>('[data-act="mute"]');
  if (mute) mute.textContent = muteIcon(muted);
}

export interface OverHandlers {
  state: GameState;
  best: number;
  isNewBest: boolean;
  coop: boolean;
  onAgain: () => void;
  onMenu: () => void;
  onShare: () => void;
}

export function screenOver(h: OverHandlers): HTMLElement {
  const s = h.state;
  const total = s.perfect + s.good + s.miss;
  const acc = total > 0 ? Math.round(((s.perfect + s.good) / total) * 100) : 0;
  const root = el(`
    <section class="screen over" aria-label="Results">
      <h2>${h.isNewBest ? 'New best!' : 'Run over'}</h2>
      <div class="over-score">${s.score.toLocaleString()}</div>
      <p class="over-sub">${h.isNewBest ? '🏆 Your best yet' : `best ${h.best.toLocaleString()}`}</p>
      <div class="over-stats">
        <div><span>${s.maxCombo}</span>max combo</div>
        <div><span>${acc}%</span>accuracy</div>
        <div class="c-perf"><span>${s.perfect}</span>perfect</div>
        <div class="c-good"><span>${s.good}</span>good</div>
        <div class="c-miss"><span>${s.miss}</span>miss</div>
      </div>
      <div class="over-actions">
        <button class="btn primary" data-act="again">${h.coop ? 'Back to lobby' : 'Play again'}</button>
        <button class="btn" data-act="share">Share score</button>
        <button class="btn ghost" data-act="menu">Menu</button>
      </div>
    </section>`);
  root.querySelector('[data-act="again"]')!.addEventListener('click', h.onAgain);
  root.querySelector('[data-act="share"]')!.addEventListener('click', h.onShare);
  root.querySelector('[data-act="menu"]')!.addEventListener('click', h.onMenu);
  return root;
}

export interface PauseHandlers {
  onResume: () => void;
  onRestart: () => void;
  onMenu: () => void;
}

export function pauseOverlay(h: PauseHandlers): HTMLElement {
  const root = el(`
    <div class="pause-overlay" role="dialog" aria-label="Paused">
      <div class="pause-card">
        <h2>Paused</h2>
        <button class="btn primary" data-act="resume">Resume</button>
        <button class="btn" data-act="restart">Restart</button>
        <button class="btn ghost" data-act="menu">Quit to menu</button>
      </div>
    </div>`);
  root.querySelector('[data-act="resume"]')!.addEventListener('click', h.onResume);
  root.querySelector('[data-act="restart"]')!.addEventListener('click', h.onRestart);
  root.querySelector('[data-act="menu"]')!.addEventListener('click', h.onMenu);
  return root;
}

export function countdownOverlay(): HTMLElement {
  return el('<div class="countdown" role="status" aria-live="assertive"><span class="count-n"></span></div>');
}
