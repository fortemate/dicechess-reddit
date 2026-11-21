import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAUNTLET_LADDER } from './daily.ts';
import { formatSpoilerFreeShareCard, pickCharacterLine } from './dialogue.ts';

describe('character dialogue & spoiler-free share card', () => {
  it('picks dialogue lines for every gauntlet boss and avoids immediate repeats', () => {
    for (const boss of GAUNTLET_LADDER) {
      const first = pickCharacterLine(boss.id, 'intro', undefined, () => 0);
      assert.equal(first.bossId, boss.id);
      assert.ok(first.text.length > 0);

      const second = pickCharacterLine(boss.id, 'intro', first.id, () => 0);
      assert.notEqual(second.id, first.id);
    }
  });

  it('formats a spoiler-free share card with First Try badge and stage icons', () => {
    const card = formatSpoilerFreeShareCard({
      dayKey: '2026-11-21',
      openingRoll: ['P', 'N', 'R'],
      firstTry: true,
      wins: 3,
      totalTurns: 41,
      rank: 2,
      stages: [
        { stage: 1, bossName: 'Rolly', outcome: 'win', turns: 8 },
        { stage: 2, bossName: 'Grabby', outcome: 'win', turns: 14 },
        { stage: 3, bossName: 'Rampage', outcome: 'win', turns: 19 },
        { stage: 4, bossName: 'Prowla', outcome: 'draw', turns: 22 },
        { stage: 4, bossName: 'Prowla', outcome: 'loss', turns: 16 },
      ],
    });
    assert.match(card, /2026-11-21/);
    assert.match(card, /⭐ First Try/);
    assert.match(
      card,
      /🟢 Rolly \(8t\) → 🟢 Grabby \(14t\) → 🟢 Rampage \(19t\) → 🟡 Prowla \(22t\) → 💀 Prowla \(16t\)/,
    );
    assert.match(card, /Streak: 3 Wins \(41 turns\) · Rank #2 today/);
  });
});
