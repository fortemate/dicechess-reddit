import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiceChess } from '@fortemate/dicechess-engine/rules';
import {
  allPeriodKeys,
  COMMUNITY_HUNT_TIERS,
  compareRuns,
  formatUtcResetCountdown,
  getCommunityHuntStatus,
  getDailyOpeningRoll,
  getDailyThemeName,
  getStageOpponent,
  msUntilNextUtcMidnight,
  STANDARD_START_FEN,
  utcDayKey,
  utcMonthKey,
  utcWeekKey,
  utcYearKey,
  withOpeningRollDfen,
} from './daily.ts';

describe('daily rules & gauntlet definitions', () => {
  it('switches UTC day, week, month, and year keys strictly at 00:00 UTC', () => {
    const beforeMidnight = Date.parse('2026-12-31T23:59:59.999Z');
    const atMidnight = Date.parse('2027-01-01T00:00:00.000Z');
    assert.equal(utcDayKey(beforeMidnight), '2026-12-31');
    assert.equal(utcMonthKey(beforeMidnight), '2026-12');
    assert.equal(utcYearKey(beforeMidnight), '2026');
    assert.equal(utcWeekKey(beforeMidnight), '2026-W53');

    const jan1 = allPeriodKeys(atMidnight);
    assert.deepEqual(jan1, {
      day: '2027-01-01',
      week: '2026-W53',
      month: '2027-01',
      year: '2027',
    });

    const jan3End = Date.parse('2027-01-03T23:59:59.999Z');
    assert.equal(utcWeekKey(jan3End), '2026-W53');

    const week1Start = Date.parse('2027-01-04T00:00:00.000Z');
    assert.equal(utcWeekKey(week1Start), '2027-W01');
  });

  it('guarantees a Pawn die and legal turn-1 moves for White and Black across 30 days', () => {
    const startMs = Date.parse('2026-11-21T00:00:00.000Z');
    const blackStartFen = STANDARD_START_FEN.replace(' w ', ' b ');

    for (let dayOffset = 0; dayOffset < 30; dayOffset += 1) {
      const dayKey = utcDayKey(startMs + dayOffset * 86_400_000);
      const roll = getDailyOpeningRoll(dayKey);
      assert.equal(roll.length, 3);
      assert.ok(roll.includes('P'), `Day ${dayKey} roll must contain a Pawn`);
      assert.ok(getDailyThemeName(roll).length > 0);

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

    const stage10 = getStageOpponent(10);
    assert.equal(stage10.isAscended, true);
    assert.equal(stage10.ascensionTier, 2);
    assert.equal(stage10.boss.id, 'prowla');
    assert.equal(stage10.playerColor, 'b');
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

  it('computes progressive Community Hunt tiers and UTC midnight countdowns', () => {
    assert.deepEqual(COMMUNITY_HUNT_TIERS, [5, 15, 30]);
    assert.deepEqual(getCommunityHuntStatus(0), {
      count: 0,
      target: 5,
      badgeLabel: null,
    });
    assert.deepEqual(getCommunityHuntStatus(5), {
      count: 5,
      target: 15,
      badgeLabel: '🥉 Bronze Dragon Slayers',
    });
    assert.deepEqual(getCommunityHuntStatus(15), {
      count: 15,
      target: 30,
      badgeLabel: '🥈 Silver Dragon Slayers',
    });
    assert.deepEqual(getCommunityHuntStatus(30), {
      count: 30,
      target: 30,
      badgeLabel: '🥇 Dragon Vanquished!',
    });

    const at2130 = Date.parse('2026-11-21T21:30:00.000Z');
    const remaining = msUntilNextUtcMidnight(at2130);
    assert.equal(remaining, 2 * 3_600_000 + 30 * 60_000);
    assert.equal(formatUtcResetCountdown(remaining), '2h 30m');
    assert.equal(formatUtcResetCountdown(30_000), '<1m');
  });
});
