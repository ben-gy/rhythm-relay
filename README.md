# Rhythm Relay

**A two-lane rhythm game — relay the beat left to right, keep the combo alive, and take a lane each with a friend over a shared link.**

🎮 Play: https://rhythm-relay.benrichardson.dev

## What it is
Notes stream down two lanes toward a glowing hit line. Tap **left** when a left note lands, **right** when a right note lands — the pattern relays back and forth between the lanes and gets denser as the track builds. Every clean hit grows a shared combo and a score multiplier; every missed note drains your energy bar and snaps the combo back to zero. Run out of energy and it's over.

The music and every falling note are generated on the fly from a seed — a kick/snare/hat groove with a bass line and a pentatonic melody blip fired by each note, all synthesised from Web Audio. There are no audio files: the chart you play *is* the melody, so good timing sounds good.

Play solo for a score-attack run, or open a room and take one lane each with a friend — the combo is *shared*, so you have to stay in sync.

## How to play
- **Desktop:** `F` / `←` / `D` = left lane · `J` / `→` / `K` = right lane · `Space` = pause · `M` = mute.
- **Mobile:** tap the **left half** of the screen for the left lane, the **right half** for the right lane.
- Clean hits build your combo and multiplier; misses drain energy. Keep the combo alive as the track speeds up.

## Multiplayer
**Live peer-to-peer co-op (2 players).** One player creates a room and shares the link; the other joins and takes the opposite lane. It's **host-authoritative**: each peer judges only its own lane locally, so WebRTC latency never affects your timing — you report hits to the host, who aggregates the shared energy / combo / multiplier / score and broadcasts a compact snapshot ~15×/second. The chart is identical on both peers (generated from one shared seed), and the whole thing is peer-to-peer with **no game server** — a free public signalling relay only brokers the initial WebRTC handshake, and no data is stored anywhere. The game is fully playable solo if nobody joins.

## Tech
- Vite 6 + vanilla TypeScript
- Canvas 2D playfield (falling notes, particles, screen shake, beat pulse) with a DOM HUD/menus
- Procedural Web-Audio music scheduled with a lookahead `setInterval` (not rAF), so the beat holds time even when a tab is backgrounded
- Shared engine: fixed-timestep loop, seedable RNG, procedural SFX, namespaced storage, Trystero P2P netcode
- Vitest for logic + P2P-sync (chart/RNG determinism, snapshot serialization) tests
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
