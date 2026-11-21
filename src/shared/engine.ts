import { DiceChess, type MoveTree } from '@fortemate/dicechess-engine';
import {
  DIE_FACES,
  formatRollForTurn,
  type DailyOpeningRoll,
  type DiePiece,
} from './daily.ts';

export type Side = 'w' | 'b';

export type GameEndReason =
  'king-captured' | '100-halfmoves' | 'turn-limit' | 'resigned' | 'timeout';

export interface GameTerminalResult {
  readonly winner: Side | null;
  readonly reason: GameEndReason;
}

export interface ParsedBoard {
  readonly pieces: ReadonlyMap<string, string>;
  readonly activeColor: Side;
  readonly halfmoveClock: number;
  readonly fullmoveNumber: number;
}

export interface TurnView {
  readonly rolledDfen: string;
  readonly currentDfen: string;
  readonly boardFen: string;
  readonly activeColor: Side;
  readonly legalNextMoves: readonly string[];
  readonly isTurnComplete: boolean;
  readonly isForcedPass: boolean;
  readonly playableDice: string;
  readonly remainingDice: string;
  readonly terminalResult: GameTerminalResult | null;
}

export interface CompletedTurnOutcome {
  readonly nextFen: string;
  readonly boardFenAfterMoves: string;
  readonly terminalResult: GameTerminalResult | null;
  readonly wasForcedPass: boolean;
  readonly capturedPieces: readonly string[];
  readonly hadPromotion: boolean;
  readonly hadCastle: boolean;
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const MAX_GAME_PLIES = 5000;

/** Parses a 6-field or 7-field FEN/DFEN into square piece codes and counters. */
export function parseFenBoard(fenOrDfen: string): ParsedBoard {
  const fields = fenOrDfen.trim().split(/\s+/);
  const boardPart = fields[0];
  if (!boardPart || fields.length < 6) {
    throw new Error(`Invalid FEN/DFEN: ${fenOrDfen}`);
  }
  const rows = boardPart.split('/');
  if (rows.length !== 8) {
    throw new Error(`Expected 8 ranks in FEN, got ${rows.length}`);
  }

  const pieces = new Map<string, string>();
  for (let r = 0; r < 8; r += 1) {
    const rank = 8 - r;
    const row = rows[r] ?? '';
    let fileIndex = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        fileIndex += Number(ch);
      } else {
        const file = FILES[fileIndex];
        if (!file) {
          throw new Error(`Rank overflow in FEN row "${row}"`);
        }
        pieces.set(`${file}${rank}`, ch);
        fileIndex += 1;
      }
    }
    if (fileIndex !== 8) {
      throw new Error(`Incomplete FEN row "${row}"`);
    }
  }

  return {
    pieces,
    activeColor: fields[1] === 'b' ? 'b' : 'w',
    halfmoveClock: Number(fields[4] ?? 0) || 0,
    fullmoveNumber: Number(fields[5] ?? 1) || 1,
  };
}

/** Strips an optional 7th DFEN dice field back down to a canonical 6-field FEN. */
export function toSixFieldFen(fenOrDfen: string): string {
  const fields = fenOrDfen.trim().split(/\s+/);
  if (fields.length < 6) {
    throw new Error(
      `Expected at least 6 FEN fields, received ${fields.length}`,
    );
  }
  return fields.slice(0, 6).join(' ');
}

/** Rolls 3 six-sided dice uniformly over P, N, B, R, Q, K. */
export function rollThreeDice(
  random: () => number = Math.random,
): DailyOpeningRoll {
  const pick = (): DiePiece => {
    const idx = Math.min(
      DIE_FACES.length - 1,
      Math.max(0, Math.floor(random() * DIE_FACES.length)),
    );
    return DIE_FACES[idx] ?? 'P';
  };
  return [pick(), pick(), pick()];
}

/**
 * Returns the dice pool for the given 1-based ply:
 * - ply 1 (White's 1st turn) and ply 2 (Black's 1st turn): Daily Opening Roll (`P + 2`)
 * - ply 3+: independent random 3-die roll
 */
export function rollForTurn(
  plyNumber: number,
  openingRoll: DailyOpeningRoll,
  random: () => number = Math.random,
): DailyOpeningRoll {
  if (plyNumber <= 2) {
    return [openingRoll[0], openingRoll[1], openingRoll[2]];
  }
  return rollThreeDice(random);
}

/** Attaches a dice roll as the 7th DFEN field matching the active color's case. */
export function buildRolledDfen(
  baseFen: string,
  roll: readonly DiePiece[],
): string {
  const sixField = toSixFieldFen(baseFen);
  const activeColor = sixField.split(' ')[1] === 'b' ? 'b' : 'w';
  return `${sixField} ${formatRollForTurn(roll, activeColor)}`;
}

/** Checks automatic Dice Chess game end conditions (King capture or draw rules). */
export function detectAutomaticResult(
  boardFen: string,
  plyNumber: number,
  isTurnEnd: boolean,
): GameTerminalResult | null {
  const fields = boardFen.trim().split(/\s+/);
  const placement = fields[0] ?? '';
  if (!placement.includes('k')) {
    return { winner: 'w', reason: 'king-captured' };
  }
  if (!placement.includes('K')) {
    return { winner: 'b', reason: 'king-captured' };
  }
  if (isTurnEnd && Number(fields[4] ?? 0) >= 100) {
    return { winner: null, reason: '100-halfmoves' };
  }
  if (isTurnEnd && plyNumber >= MAX_GAME_PLIES) {
    return { winner: null, reason: 'turn-limit' };
  }
  return null;
}

/** Inspects the current turn state along a sequence of played UCI micro-moves. */
export function getTurnView(
  baseFen: string,
  roll: readonly DiePiece[],
  playedMoves: readonly string[],
  plyNumber = 1,
): TurnView {
  const rolledDfen = buildRolledDfen(baseFen, roll);
  const rootTree = DiceChess.getLegalTurnTree(rolledDfen);
  let node: MoveTree = rootTree;
  let currentDfen = rolledDfen;

  for (const move of playedMoves) {
    const child = Object.hasOwn(node, move) ? node[move] : undefined;
    if (!child) {
      throw new Error(
        `Illegal micro-move "${move}" for position ${currentDfen}`,
      );
    }
    const applied = DiceChess.applyMove(
      currentDfen,
      move.slice(0, 2),
      move.slice(2, 4),
      move.slice(4) || undefined,
    );
    if (!applied) {
      throw new Error(`Engine rejected micro-move "${move}" on ${currentDfen}`);
    }
    currentDfen = applied;
    node = child;
  }

  const legalNextMoves = Object.keys(node);
  const isForcedPass =
    playedMoves.length === 0 && Object.keys(rootTree).length === 0;
  const isTurnComplete = legalNextMoves.length === 0;
  const fields = currentDfen.trim().split(/\s+/);
  const activeColor: Side = fields[1] === 'b' ? 'b' : 'w';
  const remainingDice = (fields[6] ?? '').toUpperCase();
  const playableDice =
    DiceChess.getPlayableDice(rolledDfen, [...playedMoves])?.toUpperCase() ??
    '';
  const boardFen = toSixFieldFen(currentDfen);
  const terminalResult = detectAutomaticResult(
    boardFen,
    plyNumber,
    isTurnComplete,
  );

  return {
    rolledDfen,
    currentDfen,
    boardFen,
    activeColor,
    legalNextMoves,
    isTurnComplete,
    isForcedPass,
    playableDice,
    remainingDice,
    terminalResult,
  };
}

/**
 * Validates a complete turn (including forced pass with `[]`) and advances the board
 * to the next side's 6-field FEN via `DiceChess.endTurn`.
 */
export function completeTurnAndAdvance(
  baseFen: string,
  roll: readonly DiePiece[],
  moves: readonly string[],
  plyNumber: number,
): CompletedTurnOutcome {
  const rolledDfen = buildRolledDfen(baseFen, roll);
  const rootTree = DiceChess.getLegalTurnTree(rolledDfen);
  const rootKeys = Object.keys(rootTree);

  if (moves.length === 0) {
    if (rootKeys.length > 0) {
      throw new Error(
        `Cannot pass turn when legal moves exist (${rootKeys[0]})`,
      );
    }
    const nextFen = DiceChess.endTurn(rolledDfen);
    if (!nextFen) {
      throw new Error(`Engine refused endTurn on forced pass: ${rolledDfen}`);
    }
    return {
      nextFen: toSixFieldFen(nextFen),
      boardFenAfterMoves: toSixFieldFen(baseFen),
      terminalResult: detectAutomaticResult(nextFen, plyNumber, true),
      wasForcedPass: true,
      capturedPieces: [],
      hadPromotion: false,
      hadCastle: false,
    };
  }

  let node: MoveTree = rootTree;
  let currentDfen = rolledDfen;
  const capturedPieces: string[] = [];
  let hadPromotion = false;
  let hadCastle = false;

  for (const move of moves) {
    const child = Object.hasOwn(node, move) ? node[move] : undefined;
    if (!child) {
      throw new Error(`Illegal turn sequence move "${move}"`);
    }
    const beforeBoard = parseFenBoard(currentDfen);
    const fromSq = move.slice(0, 2);
    const toSq = move.slice(2, 4);
    const promo = move.slice(4) || undefined;
    const movingPiece = beforeBoard.pieces.get(fromSq);
    const targetPiece = beforeBoard.pieces.get(toSq);

    if (targetPiece) {
      capturedPieces.push(targetPiece);
    } else if (
      movingPiece?.toLowerCase() === 'p' &&
      fromSq[0] !== toSq[0] &&
      !targetPiece
    ) {
      capturedPieces.push(beforeBoard.activeColor === 'w' ? 'p' : 'P');
    }
    if (promo) {
      hadPromotion = true;
    }
    if (
      movingPiece?.toLowerCase() === 'k' &&
      Math.abs(fromSq.charCodeAt(0) - toSq.charCodeAt(0)) === 2
    ) {
      hadCastle = true;
    }

    const applied = DiceChess.applyMove(currentDfen, fromSq, toSq, promo);
    if (!applied) {
      throw new Error(`Engine rejected move "${move}" on ${currentDfen}`);
    }
    currentDfen = applied;
    node = child;
  }

  if (Object.keys(node).length > 0) {
    throw new Error('Incomplete turn: additional mandatory micro-moves remain');
  }

  const boardFenAfterMoves = toSixFieldFen(currentDfen);
  const immediateResult = detectAutomaticResult(
    boardFenAfterMoves,
    plyNumber,
    true,
  );
  if (immediateResult?.reason === 'king-captured') {
    return {
      nextFen: boardFenAfterMoves,
      boardFenAfterMoves,
      terminalResult: immediateResult,
      wasForcedPass: false,
      capturedPieces,
      hadPromotion,
      hadCastle,
    };
  }

  const nextFen = DiceChess.endTurn(currentDfen);
  if (!nextFen) {
    throw new Error(`Engine refused endTurn on ${currentDfen}`);
  }
  const canonicalNext = toSixFieldFen(nextFen);
  return {
    nextFen: canonicalNext,
    boardFenAfterMoves,
    terminalResult: detectAutomaticResult(canonicalNext, plyNumber, true),
    wasForcedPass: false,
    capturedPieces,
    hadPromotion,
    hadCastle,
  };
}

/** Finds the first complete leaf path inside a non-empty MoveTree as a safe fallback. */
function firstLeafPath(tree: MoveTree): string[] {
  const path: string[] = [];
  let current: MoveTree = tree;
  while (true) {
    const keys = Object.keys(current);
    const first = keys[0];
    if (!first) break;
    path.push(first);
    const child = current[first];
    if (!child) break;
    current = child;
  }
  return path;
}

function isCompleteTurnPath(tree: MoveTree, moves: readonly string[]): boolean {
  let current: MoveTree = tree;
  for (const move of moves) {
    const child = Object.hasOwn(current, move) ? current[move] : undefined;
    if (!child) return false;
    current = child;
  }
  return Object.keys(current).length === 0;
}

/** Computes a complete legal bot turn sequence for a rolled DFEN. */
export function chooseBotTurn(
  baseFen: string,
  roll: readonly DiePiece[],
  algorithm: string,
): string[] {
  const rolledDfen = buildRolledDfen(baseFen, roll);
  const rootTree = DiceChess.getLegalTurnTree(rolledDfen);
  if (Object.keys(rootTree).length === 0) {
    return [];
  }

  const result = DiceChess.getBestMove(rolledDfen, { algorithm });
  const moves = result.moves.map(
    (m) => `${m.from}${m.to}${(m.promotion ?? '').toLowerCase()}`,
  );
  if (moves.length > 0 && isCompleteTurnPath(rootTree, moves)) {
    return moves;
  }
  return firstLeafPath(rootTree);
}

/** Returns true if `attackerSide` can capture `defenderSide`'s king in one micro-move. */
export function hasImmediateKingThreat(
  boardFen: string,
  defenderSide: Side,
): boolean {
  const parsed = parseFenBoard(boardFen);
  const targetKingSymbol = defenderSide === 'w' ? 'K' : 'k';
  let kingSquare: string | null = null;
  for (const [square, piece] of parsed.pieces.entries()) {
    if (piece === targetKingSymbol) {
      kingSquare = square;
      break;
    }
  }
  if (!kingSquare) return false;
  const attackerFen = toSixFieldFen(boardFen).replace(
    /\s[wb]\s/,
    defenderSide === 'w' ? ' b ' : ' w ',
  );
  return DiceChess.threatWeight(attackerFen, kingSquare, 1) > 0;
}
