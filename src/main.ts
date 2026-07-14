/**
 * main.ts — bootstrap + state machine. Wires screens, the fixed-timestep loop,
 * the procedural music, input, and (optionally) co-op netcode together.
 */

import './styles/main.css';
import { type Lane } from './chart';
import { Rhythm, type GameState, type Judge } from './game';
import { createRenderer, type Renderer } from './render';
import { createMusic, type Music } from './music';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { createLoop, type Loop } from './engine/loop';
import { createNet, type Net } from './engine/net';
import { createLobby, getOrCreateRoomCode } from './engine/lobby';
import { createCoop, flashCode, type Coop } from './net-game';
import {
  FOOTER_HTML,
  countdownOverlay,
  hudMarkup,
  pauseOverlay,
  screenAbout,
  screenHowTo,
  screenMenu,
  screenOver,
  updateHud,
} from './ui';

type Screen = 'menu' | 'howto' | 'about' | 'lobby' | 'playing' | 'paused' | 'over';

const APP_ID = 'rhythm-relay';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = createStore(APP_ID);
const sfx = createSfx(store.get('muted', false));
const music = createMusic('menu');

// ---- DOM skeleton -----------------------------------------------------------
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <main class="main-content" id="stage">
    <canvas class="field" id="field" hidden></canvas>
    <div class="overlay" id="overlay"></div>
  </main>
  ${FOOTER_HTML}`;
const stage = document.querySelector<HTMLElement>('#stage')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const canvas = document.querySelector<HTMLCanvasElement>('#field')!;

// ---- session state ----------------------------------------------------------
let screen: Screen = 'menu';
let muted = store.get('muted', false);
sfx.setMuted(muted);
music.setMuted(muted);

let net: Net | null = null;
let coop: Coop | null = null;
let isHost = true;
let ownLanes: Lane[] = [0, 1];

let rhythm: Rhythm | null = null;
let renderer: Renderer | null = null;
let loop: Loop | null = null;
let hud: HTMLElement | null = null;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;
let pendingFlashes: number[] = [];
let lastMultiplier = 1;
let runEnded = false;
let currentSeed: string | null = null;
let activeMusic: Music = music;
let lastLoopT = 0;

// ---- clock (pause-safe) -----------------------------------------------------
let perfAnchor = 0;
let pausedAccum = 0;
let pauseStart = 0;
function startClock(): void {
  perfAnchor = performance.now();
  pausedAccum = 0;
}
function gameNow(): number {
  return (performance.now() - perfAnchor - pausedAccum) / 1000;
}

// ---- audio unlock on first gesture -----------------------------------------
function unlockAudio(): void {
  sfx.unlock();
  music.unlock();
}
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

// ---- helpers ----------------------------------------------------------------
function show(node: HTMLElement): void {
  overlay.innerHTML = '';
  overlay.appendChild(node);
  overlay.hidden = false;
}
function clearOverlay(): void {
  overlay.innerHTML = '';
  overlay.hidden = true;
}
function setMuted(m: boolean): void {
  muted = m;
  sfx.setMuted(m);
  music.setMuted(m);
  store.set('muted', m);
  if (hud) updateHud(hud, currentState(), bestScore(), muted);
}
function bestScore(): number {
  return store.get('best', 0);
}
function currentState(): GameState {
  return (
    rhythm?.getState() ?? {
      energy: 100, combo: 0, maxCombo: 0, multiplier: 1, score: 0,
      perfect: 0, good: 0, miss: 0, over: false,
    }
  );
}
function randomName(): string {
  const a = ['Neon', 'Pulse', 'Echo', 'Vibe', 'Flux', 'Nova', 'Beat', 'Sync'];
  const b = ['Fox', 'Wolf', 'Owl', 'Cat', 'Ray', 'Jet', 'Koi', 'Bee'];
  return `${a[Math.floor(Math.random() * a.length)]}${b[Math.floor(Math.random() * b.length)]}`;
}

// ---- screens ----------------------------------------------------------------
function goMenu(): void {
  teardownSession();
  if (net) {
    try { net.leave(); } catch { /* ignore */ }
    net = null;
    coop = null;
  }
  const url = new URL(location.href);
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  }
  screen = 'menu';
  canvas.hidden = true;
  music.stop();
  show(
    screenMenu({
      best: bestScore(),
      muted,
      onSolo: () => {
        if (!store.get('seenHow', false)) {
          store.set('seenHow', true);
          show(screenHowTo(startSolo));
        } else startSolo();
      },
      onCoop: enterCoop,
      onHowTo: () => show(screenHowTo(goMenu)),
      onAbout: () => show(screenAbout(goMenu)),
      onToggleMute: () => setMuted(!muted),
    }),
  );
}

function enterCoop(): void {
  const code = getOrCreateRoomCode();
  screen = 'lobby';
  canvas.hidden = true;
  net = createNet({ appId: APP_ID, roomId: code });
  createLobby({
    container: overlay,
    net,
    roomCode: code,
    playerName: randomName(),
    minPlayers: 2,
    maxPlayers: 2,
    onStart: ({ seed, isHost: host }) => {
      isHost = host;
      ownLanes = host ? [0] : [1];
      startPlay(String(seed), true);
    },
    onCancel: goMenu,
  });
  overlay.hidden = false;
}

function startSolo(): void {
  isHost = true;
  ownLanes = [0, 1];
  startPlay(`solo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, false);
}

// ---- play -------------------------------------------------------------------
function startPlay(seed: string, isCoop: boolean): void {
  teardownSession();
  currentSeed = seed;
  runEnded = false;
  lastMultiplier = 1;
  pendingFlashes = [];

  rhythm = new Rhythm({
    seed,
    ownLanes,
    authoritative: !isCoop || isHost,
    onJudge: (ev) => juice(ev.lane, ev.result),
  });

  canvas.hidden = false;
  renderer = createRenderer(canvas, reducedMotion);
  hud = hudMarkup(isCoop);
  clearOverlay();
  stage.appendChild(hud);
  hud.querySelector('[data-act="pause"]')!.addEventListener('click', togglePause);
  hud.querySelector('[data-act="mute"]')!.addEventListener('click', () => setMuted(!muted));
  updateHud(hud, currentState(), bestScore(), muted);

  if (isCoop && net) {
    coop = createCoop(net, {
      onRemoteHit: (lane, step, result) => rhythm?.applyRemoteHit(lane, step, result),
      onSnapshot: (state, flashes) => {
        rhythm?.applySnapshot(state);
        for (const f of flashes) {
          if (!ownLanes.includes(f.lane)) juice(f.lane, f.result);
        }
        if (state.over) endRun();
      },
    });
    if (isHost) {
      broadcastTimer = setInterval(() => {
        if (rhythm) coop?.broadcast(rhythm.getState(), pendingFlashes);
        pendingFlashes = [];
      }, 66);
    }
  }

  // Re-create music with this chart's seed so the melody blips follow the notes.
  activeMusic = createMusic(seed);
  activeMusic.setMuted(muted);
  activeMusic.unlock();
  startClock();
  activeMusic.reset();
  activeMusic.start(gameNow);

  lastLoopT = 0;
  loop = createLoop({
    update: () => {
      if (screen !== 'playing' || !rhythm) return;
      let t = gameNow();
      // Absorb large frame gaps (backgrounded/throttled rAF, a devtools pause)
      // as paused time so the run never retroactively mass-misses notes.
      if (t - lastLoopT > 0.4) {
        pausedAccum += (t - lastLoopT) * 1000;
        t = gameNow();
      }
      lastLoopT = t;
      rhythm.update(t);
      if (rhythm.getState().over && !runEnded && (!isCoop || isHost)) endRun();
    },
    render: () => {
      if (!renderer || !rhythm) return;
      const t = gameNow();
      rhythm.advanceFlash(1 / 60);
      renderer.render(t, rhythm.notes, rhythm.getState());
      if (hud) updateHud(hud, rhythm.getState(), bestScore(), muted);
    },
  });
  loop.start();

  screen = 'playing';
  runCountdown();
}

function runCountdown(): void {
  const cd = countdownOverlay();
  stage.appendChild(cd);
  const label = cd.querySelector<HTMLElement>('.count-n')!;
  const words = ['3', '2', '1', 'Go!'];
  let i = 0;
  label.textContent = words[i];
  const timer = setInterval(() => {
    i++;
    if (i >= words.length) {
      clearInterval(timer);
      cd.remove();
      return;
    }
    label.textContent = words[i];
    cd.classList.remove('bump');
    void cd.offsetWidth;
    cd.classList.add('bump');
  }, 600);
}

function juice(lane: Lane, result: Judge): void {
  renderer?.burst(lane, result);
  if (result === 'miss') {
    sfx.play('hit');
    renderer?.shake(8);
  } else if (result === 'perfect') {
    sfx.play('coin');
  } else {
    sfx.play('select');
  }
  // Queue flash for co-op clients (host only accumulates).
  if (coop && isHost) pendingFlashes.push(flashCode(lane, result));
  // Multiplier tier-up flourish.
  const mult = currentState().multiplier;
  if (mult > lastMultiplier) {
    sfx.play('powerup');
    renderer?.shake(4);
  }
  lastMultiplier = mult;
}

// ---- input ------------------------------------------------------------------
function laneHit(lane: Lane): void {
  if (screen !== 'playing' || !rhythm) return;
  const t = gameNow();
  const res = rhythm.hit(lane, t);
  if (res && coop && !isHost) coop.sendHit(lane, res.step, res.result);
}

const KEY_LANE: Record<string, Lane> = {
  KeyF: 0, ArrowLeft: 0, KeyD: 0,
  KeyJ: 1, ArrowRight: 1, KeyK: 1,
};
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code in KEY_LANE) {
    e.preventDefault();
    laneHit(KEY_LANE[e.code]);
  } else if (e.code === 'Space') {
    if (screen === 'playing' || screen === 'paused') {
      e.preventDefault();
      togglePause();
    }
  } else if (e.code === 'KeyM') {
    setMuted(!muted);
  }
});
canvas.addEventListener('pointerdown', (e) => {
  if (screen !== 'playing') return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  laneHit(e.clientX - rect.left < rect.width / 2 ? 0 : 1);
});

// ---- pause / end ------------------------------------------------------------
function togglePause(): void {
  if (screen === 'playing') {
    screen = 'paused';
    pauseStart = performance.now();
    activeMusic.stop();
    const ov = pauseOverlay({
      onResume: togglePause,
      onRestart: () => {
        if (coop) { restartCoop(); } else { const s = currentSeed; if (s) startPlay(s, false); }
      },
      onMenu: goMenu,
    });
    ov.id = 'pause-ov';
    stage.appendChild(ov);
  } else if (screen === 'paused') {
    document.querySelector('#pause-ov')?.remove();
    pausedAccum += performance.now() - pauseStart;
    screen = 'playing';
    activeMusic.start(gameNow);
  }
}

function restartCoop(): void {
  // Co-op restart returns to the lobby (a fresh seed keeps peers in sync).
  document.querySelector('#pause-ov')?.remove();
  teardownSession();
  if (net) enterCoop();
}

function endRun(): void {
  if (runEnded) return;
  runEnded = true;
  screen = 'over';
  const state = currentState();
  activeMusic.stop();
  loop?.stop();
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
  canvas.hidden = true;
  hud?.remove();
  hud = null;
  sfx.play('lose');

  const isCoop = !!coop;
  let isNewBest = false;
  if (!isCoop) {
    const prev = bestScore();
    if (state.score > prev) {
      store.set('best', state.score);
      isNewBest = true;
    }
  }

  show(
    screenOver({
      state,
      best: bestScore(),
      isNewBest,
      coop: isCoop,
      onAgain: () => {
        if (isCoop) { if (net) enterCoop(); }
        else startSolo();
      },
      onMenu: goMenu,
      onShare: shareScore,
    }),
  );
}

async function shareScore(): Promise<void> {
  const state = currentState();
  const text = `I scored ${state.score.toLocaleString()} on Rhythm Relay 🎵`;
  const url = 'https://rhythm-relay.benrichardson.dev';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Rhythm Relay', text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} — ${url}`);
    toast('Score copied to clipboard');
  } catch {
    toast(`${text} — ${url}`);
  }
}

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  stage.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
}

// ---- teardown ---------------------------------------------------------------
function teardownSession(): void {
  loop?.stop();
  loop = null;
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
  if (activeMusic !== music) { activeMusic.dispose(); activeMusic = music; }
  renderer?.destroy();
  renderer = null;
  rhythm = null;
  coop = null;
  hud?.remove();
  hud = null;
  document.querySelector('#pause-ov')?.remove();
}

// ---- resize + unload --------------------------------------------------------
window.addEventListener('resize', () => renderer?.resize());
window.addEventListener('beforeunload', () => {
  try { net?.leave(); } catch { /* ignore */ }
});
// Auto-pause when the tab is hidden so a backgrounded run never dies unfairly.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && screen === 'playing') togglePause();
});

// ---- boot -------------------------------------------------------------------
function boot(): void {
  const url = new URL(location.href);
  if (url.searchParams.has('room')) {
    enterCoop(); // deep-linked invite → straight to the lobby
  } else {
    goMenu();
  }
}
boot();
