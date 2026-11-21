import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiceChess } from '@fortemate/dicechess-engine/rules';
import {
  compareRuns,
  getDailyOpeningRoll,
  getStageOpponent,
  STANDARD_START_FEN,
  utcDayKey,
  withOpeningRollDfen,
} from './daily.ts';

describe('daily rules & gauntlet definitions', () => {
  it('switches UTC day strictly at 00:00 UTC', () => {
    const beforeMidnight = Date.parse('2026-11-21T23:59:59.999Z');
    const atMidnight = Date.parse('2026-11-22T00:00:00.000Z');
    assert.equal(utcDayKey(beforeMidnight), '2026-11-21');
    assert.equal(utcDayKey(atMidnight), '2026-11-22');
  });

  it('guarantees a Pawn die and legal turn-1 moves for White and Black across 30 days', () => {
    const startMs = Date.parse('2026-11-21T00:00:00.000Z');
    const blackStartFen = STANDARD_START_FEN.replace(' w ', ' b ');

    for (let dayOffset = 0; dayOffset < 30; dayOffset += 1) {
      const dayKey = utcDayKey(startMs + dayOffset * 86_400_000);
      const roll = getDailyOpeningRoll(dayKey);
      assert.equal(roll.length, 3);
      assert.ok(roll.includes('P'), `Day ${dayKey} roll must contain a Pawn`);

      const whiteDfen = withOpeningRollDfen(STANDARD_START_FEN, roll);
      const blackDfen = withOpeningRollDfen(blackStartFen, roll);

      assert.ok(
        DiceChess.getLegalUciMoves(whiteDfen).length > 0,
        `White must have legal moves on turn 1 for ${whiteDfen}`,
      );
      assert.ok(
        DiceChess.getLegalUciMoves(blackDfen).length > 0,
        `Black must have legal moves on turn 1 for ${blackDfen}`,
      );
    }
  });

  it('maps stages 1..6 to the 6-character ladder and stages 7+ to Ascended Gauntlet', () => {
    const expectedIds = [
      'rolly',
      'grabby',
      'rampage',
      'prowla',
      'thinkle',
      'ashby',
    ];
    for (let stage = 1; stage <= 6; stage += 1) {
      const opp = getStageOpponent(stage);
      assert.equal(opp.boss.id, expectedIds[stage - 1]);
      assert.equal(opp.isAscended, false);
      assert.equal(opp.playerColor, stage % 2 === 1 ? 'w' : 'b');
    }

    const stage7 = getStageOpponent(7);
    assert.equal(stage7.isAscended, true);
    assert.equal(stage7.ascensionTier, 1);
    assert.equal(stage7.boss.id, 'prowla');
    assert.equal(stage7.playerColor, 'w');
  });

  it('orders leaderboard runs by wins desc, totalTurns asc, firstTry desc, completedAtMs asc', () => {
    const runs = [
      { wins: 4, totalTurns: 50, firstTry: false, completedAtMs: 1000 },
      { wins: 5, totalTurns: 70, firstTry: false, completedAtMs: 2000 },
      { wins: 5, totalTurns: 62, firstTry: false, completedAtMs: 1500 },
      { wins: 5, totalTurns: 62, firstTry: true, completedAtMs: 3000 },
      { wins: 5, totalTurns: 62, firstTry: true, completedAtMs: 2500 },
    ];
    const sorted = [...runs].sort(compareRuns);
    assert.deepEqual(sorted, [
      { wins: 5, totalTurns: 62, firstTry: true, completedAtMs: 2500 },
      { wins: 5, totalTurns: 62, firstTry: true, completedAtMs: 3000 },
      { wins: 5, totalTurns: 62, firstTry: false, completedAtMs: 1500 },
      { wins: 5, totalTurns: 70, firstTry: false, completedAtMs: 2000 },
      { wins: 4, totalTurns: 50, firstTry: false, completedAtMs: 1000 },
    ]);
  });
});
