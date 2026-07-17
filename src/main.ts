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
import { createRounds, type Rounds } from './engine/rematch';
import {
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
} from './engine/lobby';
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
let rounds: Rounds | null = null;
let lobby: { destroy: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let coop: Coop | null = null;
let isHost = true;
let ownLanes: Lane[] = [0, 1];
let playerName = randomName();

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

// ---- room lifecycle ---------------------------------------------------------

/** Resolves once any in-flight room teardown has fully finished. */
let roomTeardown: Promise<void> = Promise.resolve();

/**
 * Tear the room down for good. Only ever called on the way to the menu — NEVER
 * between runs. `net.leave()` is awaited because Trystero keeps the room in its
 * cache until teardown finishes; joining again before then hands back the dying
 * room and both players end up alone in the right room code, each elected host.
 * A rematch keeps the Net alive and starts a new round inside it (engine/rematch.ts).
 */
function leaveRoom(): Promise<void> {
  lobby?.destroy();
  lobby = null;
  roomEntry?.destroy();
  roomEntry = null;
  rounds?.destroy();
  rounds = null;
  const leaving = net;
  net = null;
  coop = null;
  // CHAIN, never replace. leaveRoom() runs again on the way into a new room, and
  // by then `net` is already null — replacing the promise there would hand back
  // an instantly-resolved teardown while the real one was still inside
  // Trystero's 99ms window, and the next createNet would throw.
  roomTeardown = roomTeardown.then(() => leaving?.leave()).then(
    () => undefined,
    () => undefined,
  );
  return roomTeardown;
}

// ---- screens ----------------------------------------------------------------
function goMenu(): void {
  teardownSession();
  void leaveRoom();
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
  // Deep-linked via an invite (?room=)? Jump straight into that room. Otherwise
  // show the create/join screen so a friend can type the code, not just tap the link.
  const deep = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  if (deep.length >= 3) {
    void openRoom(deep);
    return;
  }
  void leaveRoom();
  screen = 'lobby';
  canvas.hidden = true;
  roomEntry = createRoomEntry({
    container: overlay,
    title: 'Play with a friend',
    subtitle: 'Start a new room, or enter a friend’s code to join theirs.',
    onSubmit: (code) => void openRoom(code),
    onCancel: goMenu,
  });
  overlay.hidden = false;
}

/**
 * Join a room ONCE and hold it for as long as the players stay. Every run — the
 * first and every rematch — happens inside this one Net via `rounds`. Nothing
 * here may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string): Promise<void> {
  teardownSession();
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms).
  // Joining inside that window returns the dying room, so wait it out.
  await roomTeardown;
  screen = 'lobby';
  canvas.hidden = true;
  setRoomInUrl(code);

  try {
    net = createNet(
      { appId: APP_ID, roomId: code },
      { onHostChange: (_hostId, isSelfHost) => onHostChange(isSelfHost) },
    );
  } catch (err) {
    // The room is somehow still held (see engine/net.ts). Never strand the
    // player on a blank screen — say so and go back somewhere they can act.
    console.error(err);
    goMenu();
    return;
  }

  rounds = createRounds({
    net,
    playerName,
    minPlayers: 2,
    onRound: ({ seed, players, isHost: host }) => startCoopRun(seed, players, host),
  });

  showLobby(code);
}

function showLobby(code: string): void {
  if (!net || !rounds) return;
  // Drop the previous session AND any previous lobby: an orphaned lobby keeps
  // its poll alive and repaints itself over whatever screen comes next.
  teardownSession();
  lobby?.destroy();
  screen = 'lobby';
  canvas.hidden = true;
  lobby = createLobby({
    container: overlay,
    net,
    rounds,
    roomCode: code,
    minPlayers: 2,
    maxPlayers: 2,
    onCancel: goMenu,
  });
  overlay.hidden = false;
}

/**
 * Start a co-op run from the host's frozen roster. Index 0 takes lane 0, index 1
 * lane 1 — the roster arrives as identical bytes on every peer, so both players
 * agree on who owns which lane. Re-deriving it locally is how two peers end up
 * fighting over one lane while the other auto-misses on nobody.
 */
function startCoopRun(seed: number, players: { id: string }[], host: boolean): void {
  if (!net) return;
  lobby?.destroy();
  lobby = null;

  const selfIndex = players.findIndex((p) => p.id === net!.selfId);
  if (selfIndex < 0) {
    // Not in this round's roster (we arrived mid-start). Sit the run out rather
    // than silently playing as player 0 and stealing their lane.
    showLobby(normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? ''));
    toast('Next run — you’re back in the lobby');
    return;
  }

  isHost = host;
  ownLanes = [selfIndex === 0 ? 0 : 1];
  startPlay(String(seed), true);
}

/**
 * net.ts re-elects the host the instant one leaves. Mid-run that means our co-op
 * partner (the old host) dropped and we've been promoted: take over the
 * authoritative sim and both lanes so the run keeps going and can still end.
 */
function onHostChange(isSelfHost: boolean): void {
  if ((screen !== 'playing' && screen !== 'paused') || !isSelfHost || isHost) return;
  isHost = true;
  ownLanes = [0, 1];
  rhythm?.takeOver([0, 1]);
  if (!broadcastTimer) {
    broadcastTimer = setInterval(() => {
      if (rhythm) coop?.broadcast(rhythm.getState(), pendingFlashes);
      pendingFlashes = [];
    }, 66);
  }
  toast("Your partner left — you're flying solo now");
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
  // Co-op restart returns to the lobby, where a vote starts a fresh run inside
  // the SAME room. It must not leave and rejoin — see engine/net.ts.
  document.querySelector('#pause-ov')?.remove();
  // We are about to stop broadcasting. If we are the host, the partner's sim is
  // not authoritative and only ever ends via a snapshot — so without this last
  // over=true flush it would play on against a silent host and never reach its
  // results, holding the whole room hostage (it can't vote for the next run
  // either). Same reasoning as endRun().
  if (isHost && coop) coop.broadcast({ ...currentState(), over: true }, []);
  rounds?.finish();
  const code = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  if (net && rounds) showLobby(code);
  else goMenu();
}

function endRun(): void {
  if (runEnded) return;
  runEnded = true;
  screen = 'over';
  const state = currentState();
  activeMusic.stop();
  loop?.stop();
  if (broadcastTimer) {
    // The host stops ticking here, so this is the last chance to tell the client
    // the run is over. Without this final flush the client's last snapshot is a
    // live one and it sits on a dead run forever, never reaching its results.
    if (isHost && coop) coop.broadcast(state, pendingFlashes);
    pendingFlashes = [];
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
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

  rounds?.finish();

  const over = screenOver({
    state,
    best: bestScore(),
    isNewBest,
    coop: isCoop,
    onAgain: () => {
      if (!isCoop || !rounds) {
        startSolo();
        return;
      }
      // NOT a rejoin. The room and the whole peer mesh stay exactly as they are;
      // this only registers a vote, and the next run starts underneath us once
      // both players have voted. Leaving and rejoining here is what used to
      // strand both players alone as host — see engine/net.ts.
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      paintAgain();
    },
    onMenu: goMenu,
    onShare: shareScore,
  });
  show(over);

  const againBtn = over.querySelector<HTMLButtonElement>('[data-act="again"]')!;
  const status = over.querySelector<HTMLElement>('.again-status');

  function paintAgain(): void {
    if (!isCoop || !rounds || !status) return;
    const s = rounds.state();
    againBtn.textContent = s.voted ? 'Ready — waiting…' : 'Play again';
    const waiting = s.present.length - s.votes.length;
    status.textContent = s.voted
      ? waiting > 0
        ? `Waiting for ${waiting} more player${waiting === 1 ? '' : 's'}…`
        : 'Starting…'
      : `${s.votes.length}/${s.present.length} ready for another run`;
  }

  if (isCoop) {
    paintAgain();
    // The partner's vote arrives over the wire, so the count has to keep itself
    // honest rather than only repainting when this player taps.
    const tick = setInterval(() => {
      if (!document.body.contains(againBtn)) {
        clearInterval(tick);
        return;
      }
      paintAgain();
    }, 500);
  }
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
  coop?.destroy();
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
