# Dice Chess Daily (Reddit Devvit Web)

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)

Daily survival gauntlet for **Dice Chess** inside Reddit, powered by **Devvit
Web** (`@devvit/web`) and
[`@fortemate/dicechess-engine`](https://github.com/fortemate/dicechess-engine),
backed exclusively by Devvit Redis with zero external HTTP calls.

## How to Play

- **Dice Chess Core**: Each turn rolls three six-sided dice (`P` Pawn, `N`
  Knight, `B` Bishop, `R` Rook, `Q` Queen, `K` King). Play up to three
  micro-moves maximizing the dice used. There is no check or checkmate —
  **capture the enemy King to win immediately**.
- **Daily Opening Roll (`P + 2` dice)**: On turn 1 of **both White and Black**,
  the dice pool guarantees a Pawn (`P`) plus two daily-fixed dice derived
  deterministically from the `00:00 UTC` date (`Knight's Charge`,
  `Iron Cavalry`, `Royal Surge`, etc.). From turn 2 onward, dice rolls are
  independent and random.
- **6-Character Boss Gauntlet & Ascended Mode**:
  1. **Rolly** (Forest Pixie) — `random-king-capture`
  2. **Grabby** (Treasure Goblin) — `greedy`
  3. **Rampage** (Little Imp) — `checkmate-aware`
  4. **Prowla** (Cat Sorceress) — `greedy-v2`
  5. **Thinkle** (Star Wizard) — `aggressive`
  6. **Ashby** (Mountain Dragon — Daily Boss) — `aggressive` (Ashby strikes
     first as White)
  7. **Stage 7+ (Ascended Gauntlet)**: Endless escalating stages until your
     first loss.
- **3+2 Time Control & Between-Game Pauses**: `3+2` (3 minutes base + 2 seconds
  increment after a complete turn). You may **pause freely between matches** on
  the stage-transition screen; active in-game clocks keep ticking server-side if
  the window closes.
- **Attempts, Scoring & Leaderboards**:
  - Unlimited daily attempts (your best run counts); your first attempt each UTC
    day earns the **`⭐ First Try`** badge.
  - Score counts **Wins** before your first loss. A draw holds your current
    stage for a replay with your streak intact.
  - Tie-breakers: (1) fewer total turns across winning games, (2)
    `⭐ First Try`, (3) earlier completion timestamp.
  - **Day / Week / Month / Year** leaderboards aligned to `00:00 UTC`.
- **Reddit Community Features**:
  - **Live Feed Preview (`splash.html`)**: Shows today's `P + 2` roll, tiered
    Ashby Community Hunt progress (`5 / 15 / 30` players) with celebration
    badges, Top 3 daily streaks, UTC reset countdown, and context-aware
    Start/Resume button.
  - **Asynchronous Rivalry & Personal Bests**: Tracks your nearest daily rival
    above you on the leaderboard (`🎯 Beat #k`), marks their target stage on the
    ladder strip, and celebrates new daily personal records (`🏆`).
  - **Stage Epitaphs**: Displays the percentage of daily runs eliminated on the
    upcoming boss and the last fallen hero.
  - **1-Click Spoiler-Free Comment Card**: Copy or post a compact chronicle
    (`🟢 / 🟡 / 💀`) to the daily post comments on demand.

## Architecture

- `src/shared/` — Isomorphic rules & domain logic (`daily.ts`, `engine.ts`,
  `dialogue.ts`, `api.ts`)
- `src/server/` — Devvit Web CJS server (`server.ts`, `db.ts`) persisting runs,
  clocks, epitaphs, community hunt, and Day/Week/Month/Year leaderboards in
  `@devvit/web/server` Redis, plus standalone local dev server (`local-dev.ts`,
  `redis-mock.ts`)
- `src/client/` & `public/` — Mobile-first Custom Post Preview (`splash.html`,
  `splash.ts`) and interactive board & gauntlet views (`game.html`, `game.ts`,
  `avatars.ts`, `audio.ts`, `guest.ts`)
- `public/pieces/` — CC0-1.0 vector chess piece SVGs (RhosGFX)

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for package and asset
notices.

## Local Development

```bash
mise install
mise exec -- npm ci
mise exec -- lefthook install
mise exec -- npm run check
```

To run the splash and full gauntlet locally without authenticating with Reddit
(`http://127.0.0.1:4173/splash.html` and `http://127.0.0.1:4173/game.html`):

```bash
mise exec -- npm run dev:local
```

## License

Project-authored code and documentation are licensed under
**[AGPL-3.0-only](LICENSE)** (matching `dicechess-engine`). External
contributors sign [CLA.md](CLA.md).
