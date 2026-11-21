# Dice Chess Daily (Reddit Devvit Web)

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)

Daily survival gauntlet for **Dice Chess** inside Reddit, powered by **Devvit
Web** and
[`@fortemate/dicechess-engine`](https://github.com/fortemate/dicechess-engine).

> [!NOTE] Initial repository bootstrap: core daily-gauntlet rules, server
> endpoints, and Devvit Web scaffold are in place and tested; full interactive
> gameplay board, Redis run persistence, and Reddit UI polish are under active
> development.

## Game Rules & Daily Format

- **Dice Chess Core**: On each turn you roll three six-sided dice (`1` Pawn, `2`
  Knight, `3` Bishop, `4` Rook, `5` Queen, `6` King) and play up to three
  micro-moves. There is no check or checkmate — win by capturing the opponent's
  King.
- **Daily Opening Roll (`P + 2` dice)**: On turn 1 of **both White and Black**,
  the dice pool guarantees a Pawn (`P`) plus two deterministic daily dice fixed
  for the entire `00:00 UTC` day. From turn 2 onward, dice rolls are independent
  and random.
- **6-Character Gauntlet & Ascended Mode**:
  1. **Rolly** (Pixie)
  2. **Grabby** (Goblin)
  3. **Rampage** (Imp)
  4. **Prowla** (Cat Sorceress)
  5. **Thinkle** (Wizard)
  6. **Ashby** (Dragon — Daily Boss)
  7. **Stage 7+ (Ascended Gauntlet)**: Endless escalating stages until your
     first loss.
- **Time Control & Pauses**: `3+2` (3 minutes base + 2 seconds increment after
  each complete turn). Pause is allowed **between games**; active game clocks
  continue to run if the window closes.
- **Attempts & Leaderboards**:
  - Unlimited daily attempts (your best run of the day counts); your first
    attempt each day earns the **`First Try ⭐`** badge.
  - Score counts **Wins** before your first loss; a draw holds the current stage
    for a replay.
  - Tie-breakers: (1) fewer total turns across winning games, (2)
    `First Try ⭐`, (3) earlier completion timestamp.
  - Separate **Day / Week / Month / Year** leaderboards stored in Devvit Redis
    (`00:00 UTC` day reset) with zero external HTTP calls.

## Local Development

```bash
mise install
mise exec -- npm install
mise exec -- lefthook install
mise exec -- npm run check
```

## License

Licensed under **[AGPL-3.0-only](LICENSE)** (matching `dicechess-engine`).
External contributions require signing [CLA.md](CLA.md).
