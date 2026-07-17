/**
 * render.ts — Canvas 2D playfield: falling notes, hit line, beat pulse,
 * particle bursts, screen shake, and the big combo counter. HUD chrome
 * (energy bar, score) lives in the DOM (ui.ts); this owns the animated field.
 */

import { STEP_SEC, STEPS_PER_BEAT, type Lane } from './chart';
import type { GameState, Judge, Note } from './game';

const COL = {
  bg0: '#0e0b1e',
  bg1: '#161033',
  left: '#22d3ee',
  right: '#f59e0b',
  perfect: '#f8fafc',
  miss: '#fb7185',
  line: '#c4b5fd',
  text: '#e9e7ff',
};

const laneColor = (lane: Lane): string => (lane === 0 ? COL.left : COL.right);

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  shard: boolean;
}

export interface Renderer {
  resize(): void;
  burst(lane: Lane, result: Judge): void;
  shake(amount: number): void;
  render(now: number, notes: readonly Note[], state: GameState): void;
  destroy(): void;
}

/**
 * `leadSec` is the mode's note travel time and MUST be the one the sim spawned
 * with: it is the only thing that maps a note's target time onto a y position,
 * so a renderer holding a different value draws every note away from the line it
 * is actually judged at.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  reducedMotion: boolean,
  leadSec: number,
): Renderer {
  const ctx = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  let dpr = 1;

  const particles: Particle[] = [];
  let shakeAmt = 0;
  const laneFlash: [number, number] = [0, 0]; // per-lane hit-line flash 0..1
  const laneFlashColor: [string, string] = [COL.perfect, COL.perfect];

  let lastNow = 0;
  let comboShown = 0;
  let comboPop = 0;

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function geom() {
    const fieldW = Math.min(w * 0.92, 460);
    const cx = w / 2;
    const laneW = fieldW / 2;
    const hitY = h * 0.8;
    const leftX = cx - laneW / 2;
    const rightX = cx + laneW / 2;
    return { fieldW, cx, laneW, hitY, leftX, rightX, topY: -30 };
  }

  function laneX(lane: Lane): number {
    const g = geom();
    return lane === 0 ? g.leftX : g.rightX;
  }

  function burst(lane: Lane, result: Judge): void {
    const g = geom();
    const x = laneX(lane);
    const y = g.hitY;
    const color = result === 'miss' ? COL.miss : result === 'perfect' ? COL.perfect : laneColor(lane);
    laneFlash[lane] = 1;
    laneFlashColor[lane] = color;
    if (reducedMotion) return;
    const n = result === 'perfect' ? 18 : result === 'good' ? 10 : 12;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const sp = (result === 'miss' ? 90 : 150) * (0.5 + Math.random());
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (result === 'miss' ? 0 : 40),
        life: 0,
        max: 0.5 + Math.random() * 0.3,
        size: result === 'miss' ? 3 : 4,
        color,
        shard: result === 'miss',
      });
    }
  }

  function shake(amount: number): void {
    if (reducedMotion) return;
    shakeAmt = Math.min(16, shakeAmt + amount);
  }

  function updateParticles(dt: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 320 * dt; // gravity
      p.vx *= 0.98;
    }
    laneFlash[0] = Math.max(0, laneFlash[0] - dt * 3.5);
    laneFlash[1] = Math.max(0, laneFlash[1] - dt * 3.5);
    shakeAmt = Math.max(0, shakeAmt - dt * 60);
  }

  function noteY(n: Note, now: number): number {
    const g = geom();
    const spawn = n.time - leadSec;
    const prog = (now - spawn) / leadSec; // 0 at spawn, 1 at line
    return g.topY + (g.hitY - g.topY) * prog;
  }

  function drawBackground(now: number): void {
    const beat = now / (STEP_SEC * STEPS_PER_BEAT);
    const phase = beat - Math.floor(beat);
    const pulse = reducedMotion ? 0 : Math.max(0, 1 - phase) * 0.12;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, COL.bg1);
    grad.addColorStop(1, COL.bg0);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    if (pulse > 0) {
      ctx.fillStyle = `rgba(124,58,237,${pulse})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function drawField(now: number): void {
    const g = geom();
    // Lane guide columns.
    for (const lane of [0, 1] as Lane[]) {
      const x = laneX(lane);
      const col = laneColor(lane);
      const grad = ctx.createLinearGradient(0, 0, 0, g.hitY);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, hexA(col, 0.08));
      ctx.fillStyle = grad;
      ctx.fillRect(x - g.laneW / 2, 0, g.laneW, g.hitY);
      ctx.strokeStyle = hexA(col, 0.18);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - g.laneW / 2, 0, g.laneW, g.hitY);
    }
    // Hit line.
    const beat = now / (STEP_SEC * STEPS_PER_BEAT);
    const phase = beat - Math.floor(beat);
    const glow = reducedMotion ? 0.3 : 0.25 + Math.max(0, 1 - phase) * 0.5;
    ctx.strokeStyle = hexA(COL.line, glow);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(g.cx - g.fieldW / 2, g.hitY);
    ctx.lineTo(g.cx + g.fieldW / 2, g.hitY);
    ctx.stroke();
    // Target rings + lane flash.
    for (const lane of [0, 1] as Lane[]) {
      const x = laneX(lane);
      const r = 26 + laneFlash[lane] * 16;
      ctx.strokeStyle = hexA(laneColor(lane), 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, g.hitY, 24, 0, Math.PI * 2);
      ctx.stroke();
      if (laneFlash[lane] > 0) {
        ctx.strokeStyle = hexA(laneFlashColor[lane], laneFlash[lane]);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, g.hitY, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Key hint.
      ctx.fillStyle = hexA(COL.text, 0.35);
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(lane === 0 ? 'F  /  ◀' : '▶  /  J', x, g.hitY + 44);
    }
  }

  function drawNotes(now: number, notes: readonly Note[]): void {
    const g = geom();
    for (const n of notes) {
      const y = noteY(n, now);
      if (y < -40 || y > h + 40) continue;
      const x = laneX(n.lane);
      const col = laneColor(n.lane);
      if (n.judged) {
        if (n.result === 'miss') {
          // Missed note keeps falling, dimming.
          const alpha = Math.max(0, 0.5 - n.flash);
          if (alpha <= 0) continue;
          drawNote(x, y + n.flash * 120, g.laneW, hexA(COL.miss, alpha), 0);
        }
        continue;
      }
      // Approaching note: brighten near the line.
      const nearness = 1 - Math.min(1, Math.abs(y - g.hitY) / (g.hitY * 0.5));
      drawNote(x, y, g.laneW, col, nearness);
    }
  }

  function drawNote(x: number, y: number, laneW: number, color: string, glow: number): void {
    const width = laneW * 0.66;
    const height = 20;
    ctx.save();
    if (glow > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 + glow * 18;
    }
    ctx.fillStyle = color;
    roundRect(x - width / 2, y - height / 2, width, height, 10);
    ctx.fill();
    ctx.restore();
  }

  function drawCombo(state: GameState): void {
    if (state.combo !== comboShown) {
      if (state.combo > comboShown && !reducedMotion) comboPop = 1;
      comboShown = state.combo;
    }
    if (state.combo < 2) return;
    const g = geom();
    const scale = 1 + comboPop * 0.4;
    const tierCol = state.multiplier >= 8 ? COL.right : state.multiplier >= 4 ? '#a78bfa' : state.multiplier >= 2 ? COL.left : COL.text;
    ctx.save();
    ctx.translate(g.cx, h * 0.34);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.fillStyle = tierCol;
    ctx.font = '800 54px system-ui, sans-serif';
    ctx.fillText(String(state.combo), 0, 0);
    ctx.fillStyle = hexA(COL.text, 0.7);
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText(state.multiplier > 1 ? `COMBO · ×${state.multiplier}` : 'COMBO', 0, 26);
    ctx.restore();
  }

  function drawParticles(): void {
    for (const p of particles) {
      const a = 1 - p.life / p.max;
      ctx.fillStyle = hexA(p.color, a);
      if (p.shard) {
        ctx.fillRect(p.x, p.y, p.size + 1, p.size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function render(now: number, notes: readonly Note[], state: GameState): void {
    const dt = Math.min(0.05, Math.max(0, now - lastNow));
    lastNow = now;
    updateParticles(dt);
    comboPop = Math.max(0, comboPop - dt * 4);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    if (shakeAmt > 0) {
      ctx.translate((Math.random() - 0.5) * shakeAmt, (Math.random() - 0.5) * shakeAmt);
    }
    drawBackground(now);
    drawField(now);
    drawNotes(now, notes);
    drawParticles();
    drawCombo(state);
    ctx.restore();
  }

  function roundRect(x: number, y: number, ww: number, hh: number, r: number): void {
    const rr = Math.min(r, ww / 2, hh / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + ww, y, x + ww, y + hh, rr);
    ctx.arcTo(x + ww, y + hh, x, y + hh, rr);
    ctx.arcTo(x, y + hh, x, y, rr);
    ctx.arcTo(x, y, x + ww, y, rr);
    ctx.closePath();
  }

  resize();
  return { resize, burst, shake, render, destroy() { particles.length = 0; } };
}

/** Apply an alpha to a #rrggbb colour → rgba() string. */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
