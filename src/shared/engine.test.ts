import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAUNTLET_LADDER, STANDARD_START_FEN } from './daily.ts';
import {
  chooseBotTurn,
  completeTurnAndAdvance,
  getTurnView,
  hasImmediateKingThreat,
  parseFenBoard,
  rollForTurn,
} from './engine.ts';

describe('engine turn-tree & bot integration', () => {
  it('applies Daily Opening Roll on plies 1 and 2 and rolls randomly on ply 3+', () => {
    const opening: readonly ['P', 'N', 'R'] = ['P', 'N', 'R'];
    assert.deepEqual(
      rollForTurn(1, opening, () => 0.99),
      ['P', 'N', 'R'],
    );
    assert.deepEqual(
      rollForTurn(2, opening, () => 0.99),
      ['P', 'N', 'R'],
    );
    const third = rollForTurn(3, opening, () => 0.99);
    assert.deepEqual(third, ['K', 'K', 'K']);
  });

  it('tracks micro-moves through TurnView and commits full turns cleanly', () => {
    const view0 = getTurnView(STANDARD_START_FEN, ['P', 'N', 'R'], []);
    assert.equal(view0.isForcedPass, false);
    assert.equal(view0.isTurnComplete, false);
    assert.ok(view0.legalNextMoves.includes('e2e4'));

    const view1 = getTurnView(STANDARD_START_FEN, ['P', 'N', 'R'], ['e2e4']);
    assert.equal(view1.isTurnComplete, false);
    assert.ok(view1.legalNextMoves.includes('g1f3'));

    assert.throws(
      () =>
        completeTurnAndAdvance(
          STANDARD_START_FEN,
          ['P', 'N', 'R'],
          ['e2e4'],
          1,
        ),
      /Incomplete turn/,
    );

    const outcome = completeTurnAndAdvance(
      STANDARD_START_FEN,
      ['P', 'N', 'R'],
      ['e2e4', 'g1f3', 'h1g1'],
      1,
    );
    assert.equal(outcome.wasForcedPass, false);
    assert.equal(outcome.terminalResult, null);
    assert.equal(parseFenBoard(outcome.nextFen).activeColor, 'b');
  });

  it('detects forced passes and allows zero-move pass only when root tree is empty', () => {
    const view = getTurnView(STANDARD_START_FEN, ['Q', 'Q', 'Q'], []);
    assert.equal(view.isForcedPass, true);
    assert.equal(view.isTurnComplete, true);
    assert.equal(view.legalNextMoves.length, 0);

    const passed = completeTurnAndAdvance(
      STANDARD_START_FEN,
      ['Q', 'Q', 'Q'],
      [],
      1,
    );
    assert.equal(passed.wasForcedPass, true);
    assert.equal(parseFenBoard(passed.nextFen).activeColor, 'b');

    assert.throws(
      () => completeTurnAndAdvance(STANDARD_START_FEN, ['P', 'N', 'R'], [], 1),
      /Cannot pass turn/,
    );
  });

  it('detects immediate king capture victory and 100-halfmove draw', () => {
    const kingCapFen = '4k3/8/8/8/4Q3/8/8/4K3 w - - 0 1';
    const outcome = completeTurnAndAdvance(
      kingCapFen,
      ['Q', 'P', 'P'],
      ['e4e8'],
      1,
    );
    assert.deepEqual(outcome.terminalResult, {
      winner: 'w',
      reason: 'king-captured',
    });
    assert.deepEqual(outcome.capturedPieces, ['k']);

    const halfmoveFen = '4k3/8/8/8/8/8/8/4K3 w - - 99 50';
    const drawOutcome = completeTurnAndAdvance(
      halfmoveFen,
      ['K', 'Q', 'Q'],
      ['e1d1'],
      100,
    );
    assert.deepEqual(drawOutcome.terminalResult, {
      winner: null,
      reason: '100-halfmoves',
    });
  });

  it('produces complete valid bot turns for all 6 gauntlet characters', () => {
    for (const boss of GAUNTLET_LADDER) {
      const moves = chooseBotTurn(
        STANDARD_START_FEN,
        ['P', 'N', 'R'],
        boss.engineAlgorithm,
      );
      assert.ok(moves.length >= 1, `${boss.id} must choose a legal turn`);
      const outcome = completeTurnAndAdvance(
        STANDARD_START_FEN,
        ['P', 'N', 'R'],
        moves,
        1,
      );
      assert.equal(parseFenBoard(outcome.nextFen).activeColor, 'b');
    }
  });

  it('detects immediate king threat on the board', () => {
    const safeFen = STANDARD_START_FEN;
    assert.equal(hasImmediateKingThreat(safeFen, 'w'), false);

    const threatenedFen = '4k3/8/8/8/4q3/8/8/4K3 w - - 0 1';
    assert.equal(hasImmediateKingThreat(threatenedFen, 'w'), true);
  });
});
