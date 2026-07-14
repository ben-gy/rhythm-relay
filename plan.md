# Game Plan: Rhythm Relay

## Overview
- **Name:** Rhythm Relay
- **Repo name:** rhythm-relay
- **Tagline:** A two-lane rhythm game — pass the beat left to right, keep the combo alive, and (with a friend) share one lane each over a link.
- **Genre (directory category):** arcade

## Core Loop
Notes stream down two lanes toward a glowing hit line. Tap **left** when a left note lands, **right** when a right note lands. The pattern relays back and forth between the lanes and gets denser as the track builds. Every clean hit grows a shared **combo** and a score multiplier; every missed note drains your **energy** bar and snaps the combo back to zero. Empty energy ends the run. The tension is the escalating density: the track keeps handing you the beat faster, and the combo you've built is always one slip from gone.

- **Win/goal:** score-attack — beat your best. Endless track that ramps in intensity.
- **Lose:** energy hits zero.

## Controls
- **Desktop:** `F` / `←` / `D` = left lane · `J` / `→` / `K` = right lane · `Space` = pause · `M` = mute.
- **Mobile:** tap the **left half** of the screen for the left lane, the **right half** for the right lane. Two big always-visible lane buttons; tap targets are the full half-screen (≫44px).

## Multiplayer
- **Mode:** live P2P **co-op** (2 players) + solo (one player plays both lanes).
- **Live P2P:** 2 players, **host-authoritative**. The lobby broadcasts one shared seed; both peers generate the **identical** note chart from it (`rng.ts`). Player 0 owns the **left** lane, player 1 owns the **right** lane — each peer judges only its own lane locally (so WebRTC latency never affects timing) and sends `{step, judge}` hit events on the `hit` channel. The host aggregates all hits into the shared energy / combo / multiplier / score, authoritatively detects missed notes (a note whose window passes with no hit event), and broadcasts a compact snapshot on `snap` at 15Hz. Clients render the shared HUD from snapshots and their own lane locally for instant feedback.
  - **Late joiner:** the chart is a pure function of the seed + step, so a joiner reconstructs everything; the host's next snapshot resyncs energy/combo/score.
  - **Host leaves:** `net.ts` re-elects the lexicographically-smallest peer; every client caches the last snapshot, so the promoted host resumes aggregation from it.
  - **Channels (≤12 bytes):** `hit` (client→host hit events), `snap` (host→all state snapshot).
  - Fully playable solo if nobody joins.

## Juice Plan
- **Procedural music (the star):** a Web-Audio groove scheduler (`music.ts`) with a lookahead `setInterval` (NOT rAF) — kick on every beat, snare on the backbeat, hats on the offbeats, a bass note per bar, and a pentatonic melody blip fired by each chart note. The chart you play *is* the melody, so good play sounds good.
- **Hit feedback:** ring-burst particles + a bright flash at the hit line on Perfect, a softer pop on Good, a red shard-burst + screen shake on Miss.
- **Combo:** big centered combo counter that scales-and-settles (tween) on each increment, colour shifting up the multiplier tiers; a shockwave ring at each new tier.
- **Beat pulse:** the whole field + hit line pulse on every kick; background gradient breathes with intensity.
- **Energy bar:** tweened fill, flashes and shakes when drained.
- All shake/particles respect `prefers-reduced-motion` (degrade to flashes only).

## Style Direction
**Vibe:** neon.
**Palette:** deep indigo backdrop (`#0e0b1e`), left lane **cyan** `#22d3ee`, right lane **amber** `#f59e0b` (cyan/amber is colour-blind-safe — distinct in hue *and* brightness, and never red/green), Perfect flashes white, Miss uses a desaturated rose `#fb7185` plus a shape cue (shards) so it's not colour-only.
**Theme:** dark (arcade/neon).
**Reference feel:** the clean two-lane tap feel of a good mobile rhythm game + the escalating-build tension of a rhythm score-attack. Feel only, no IP.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** Canvas 2D for the scrolling field, particles, shake; DOM overlays for menus/HUD/modals.
- **Engine modules copied from patterns/:** loop, rng, sound, storage, net, lobby. (Rhythm uses custom full-half-screen tap zones + direct keydown for sample-accurate hit timing instead of the virtual D-pad, so `input.ts` is intentionally not used.)
- **Persistence:** localStorage — best score, mute pref, "seen how-to" flag (`storage.ts`).

## Non-Goals
- No 4+ lane charts, no imported audio files, no song select — one endless procedural track that ramps.
- No versus scoring race (co-op only this run).
- No account/leaderboard beyond the local best.

## How To Play (player-facing copy)
Notes fall down two lanes. Tap **left** (F / ←) the instant a left note hits the line, **right** (J / →) for a right note — or tap the left/right half of the screen on mobile. Clean hits build a combo and multiplier; misses drain your energy. Keep the combo alive as the track speeds up. Playing with a friend? One of you takes each lane over a shared link — the combo is shared, so stay in sync.
