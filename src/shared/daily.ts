export type DiePiece = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K';

export type DailyOpeningRoll = readonly [DiePiece, DiePiece, DiePiece];

export type BossId =
  'rolly' | 'grabby' | 'rampage' | 'prowla' | 'thinkle' | 'ashby';

export interface DieMeta {
  readonly face: DiePiece;
  readonly pip: 1 | 2 | 3 | 4 | 5 | 6;
  readonly label: string;
  readonly symbol: string;
}

export interface BossCharacter {
  readonly id: BossId;
  readonly name: string;
  readonly creature: string;
  readonly stage: number;
  readonly engineAlgorithm: string;
  readonly accentColor: string;
  readonly summary: string;
}

export interface StageOpponent {
  readonly stage: number;
  readonly boss: BossCharacter;
  readonly playerColor: 'w' | 'b';
  readonly isAscended: boolean;
  readonly ascensionTier: number;
}

export interface RunResult {
  readonly wins: number;
  readonly totalTurns: number;
  readonly firstTry: boolean;
  readonly completedAtMs: number;
}

export interface PeriodKeys {
  readonly day: string;
  readonly week: string;
  readonly month: string;
  readonly year: string;
}

/** 3+2 time control: 3 minutes base plus 2s increment after a complete turn. */
export const INITIAL_CLOCK_MS = 180_000;
export const INCREMENT_MS = 2_000;

export const STANDARD_START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const DIE_FACES: readonly DiePiece[] = ['P', 'N', 'B', 'R', 'Q', 'K'];

export const DIE_METADATA: Readonly<Record<DiePiece, DieMeta>> = {
  P: { face: 'P', pip: 1, label: 'Pawn', symbol: '♙' },
  N: { face: 'N', pip: 2, label: 'Knight', symbol: '♘' },
  B: { face: 'B', pip: 3, label: 'Bishop', symbol: '♗' },
  R: { face: 'R', pip: 4, label: 'Rook', symbol: '♖' },
  Q: { face: 'Q', pip: 5, label: 'Queen', symbol: '♕' },
  K: { face: 'K', pip: 6, label: 'King', symbol: '♔' },
};

const DIE_ORDER: Readonly<Record<DiePiece, number>> = {
  P: 1,
  N: 2,
  B: 3,
  R: 4,
  Q: 5,
  K: 6,
};

export const GAUNTLET_LADDER: readonly BossCharacter[] = [
  {
    id: 'rolly',
    name: 'Rolly',
    creature: 'Forest Pixie',
    stage: 1,
    engineAlgorithm: 'random-king-capture',
    accentColor: '#eab308',
    summary: 'Trusts the dice completely, but never misses an open King.',
  },
  {
    id: 'grabby',
    name: 'Grabby',
    creature: 'Treasure Goblin',
    stage: 2,
    engineAlgorithm: 'greedy',
    accentColor: '#a855f7',
    summary: 'Grabs the highest-value piece in reach without looking ahead.',
  },
  {
    id: 'rampage',
    name: 'Rampage',
    creature: 'Little Imp',
    stage: 3,
    engineAlgorithm: 'checkmate-aware',
    accentColor: '#ef4444',
    summary: 'Guards his own King while hunting any opening on yours.',
  },
  {
    id: 'prowla',
    name: 'Prowla',
    creature: 'Cat Sorceress',
    stage: 4,
    engineAlgorithm: 'greedy-v2',
    accentColor: '#ec4899',
    summary: 'Snatches material without exposing her King to counter-rolls.',
  },
  {
    id: 'thinkle',
    name: 'Thinkle',
    creature: 'Star Wizard',
    stage: 5,
    engineAlgorithm: 'aggressive',
    accentColor: '#38bdf8',
    summary: 'Pushes pawns, attacks pieces, and forces King danger early.',
  },
  {
    id: 'ashby',
    name: 'Ashby',
    creature: 'Mountain Dragon',
    stage: 6,
    engineAlgorithm: 'aggressive',
    accentColor: '#f97316',
    summary: 'Daily Boss — strikes first as White with relentless pressure.',
  },
];

const ASCENDED_POOL: readonly BossCharacter[] = GAUNTLET_LADDER.slice(3);

/** Returns the canonical YYYY-MM-DD day key using the 00:00 UTC boundary. */
export function utcDayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Returns the ISO-8601 UTC week key (YYYY-Www). */
export function utcWeekKey(nowMs: number = Date.now()): string {
  const source = new Date(nowMs);
  const date = new Date(
    Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth(),
      source.getUTCDate(),
    ),
  );
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Returns the UTC month key (YYYY-MM). */
export function utcMonthKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** Returns the UTC year key (YYYY). */
export function utcYearKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 4);
}

/** Returns all calendar leaderboard keys aligned to 00:00 UTC. */
export function allPeriodKeys(nowMs: number = Date.now()): PeriodKeys {
  return {
    day: utcDayKey(nowMs),
    week: utcWeekKey(nowMs),
    month: utcMonthKey(nowMs),
    year: utcYearKey(nowMs),
  };
}

/** Deterministic 32-bit FNV-1a hash for generating repeatable daily hooks. */
function hashDayKey(dayKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < dayKey.length; i += 1) {
    hash ^= dayKey.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Generates the community-shared Daily Opening Roll (`P + 2` dice).
 * Turn 1 of both White and Black uses this pool to guarantee legal opening play.
 */
export function getDailyOpeningRoll(dayKey: string): DailyOpeningRoll {
  const seed = hashDayKey(dayKey);
  const second = DIE_FACES[seed % DIE_FACES.length] ?? 'N';
  const third = DIE_FACES[(seed >>> 8) % DIE_FACES.length] ?? 'R';
  const sorted = (['P', second, third] as DiePiece[]).sort(
    (a, b) => DIE_ORDER[a] - DIE_ORDER[b],
  );
  return [sorted[0] ?? 'P', sorted[1] ?? 'P', sorted[2] ?? 'P'];
}

/** Returns an evocative daily theme title derived from the fixed opening roll. */
export function getDailyThemeName(roll: DailyOpeningRoll): string {
  const extras = roll.slice(1).join('');
  switch (extras) {
    case 'PP':
      return 'Pawn Phalanx';
    case 'PN':
    case 'NN':
      return "Knight's Charge";
    case 'PB':
    case 'BB':
      return "Bishop's Fianchetto";
    case 'PR':
    case 'RR':
      return 'Rook Vanguard';
    case 'PQ':
    case 'QQ':
      return 'Royal Surge';
    case 'PK':
    case 'KK':
      return 'King March';
    case 'NB':
      return 'Minor Piece Blitz';
    case 'NR':
      return 'Iron Cavalry';
    case 'NQ':
      return 'Knight & Queen Gambit';
    case 'NK':
      return 'Knight Escort';
    case 'BR':
      return 'Diagonal Cannon';
    case 'BQ':
      return 'Imperial Diagonal';
    case 'BK':
      return 'Crown Sanctuary';
    case 'RQ':
      return 'Heavy Battery';
    case 'RK':
      return 'Castle Wall';
    case 'QK':
      return 'Sovereign Opening';
    default:
      return 'Daily Gauntlet';
  }
}

/** Formats a roll in DFEN case matching the active side (`w` uppercase, `b` lowercase). */
export function formatRollForTurn(
  roll: readonly DiePiece[],
  activeColor: 'w' | 'b',
): string {
  const joined = roll.join('');
  return activeColor === 'w' ? joined.toUpperCase() : joined.toLowerCase();
}

/** Attaches a Daily Opening Roll as the 7th DFEN field on a 6-field FEN. */
export function withOpeningRollDfen(
  baseFen: string,
  roll: DailyOpeningRoll,
): string {
  const fields = baseFen.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new Error(`Expected 6-field FEN, received ${fields.length} fields`);
  }
  const activeColor = fields[1] === 'b' ? 'b' : 'w';
  return `${fields.join(' ')} ${formatRollForTurn(roll, activeColor)}`;
}

/** Resolves the opponent and color assignment for a given 1-based gauntlet stage. */
export function getStageOpponent(stage: number): StageOpponent {
  if (!Number.isInteger(stage) || stage < 1) {
    throw new Error(`Stage must be a positive integer, received ${stage}`);
  }
  const playerColor: 'w' | 'b' = stage % 2 === 1 ? 'w' : 'b';
  if (stage <= GAUNTLET_LADDER.length) {
    const boss = GAUNTLET_LADDER[stage - 1]!;
    return {
      stage,
      boss,
      playerColor,
      isAscended: false,
      ascensionTier: 0,
    };
  }
  const offset = stage - GAUNTLET_LADDER.length - 1;
  const boss = ASCENDED_POOL[offset % ASCENDED_POOL.length]!;
  return {
    stage,
    boss,
    playerColor,
    isAscended: true,
    ascensionTier: Math.floor(offset / ASCENDED_POOL.length) + 1,
  };
}

/** Tiered Community Hunt thresholds calibrated for both test subreddits and full traffic. */
export const COMMUNITY_HUNT_TIERS = [5, 15, 30] as const;

export interface CommunityHuntStatus {
  readonly count: number;
  readonly target: number;
  readonly badgeLabel: string | null;
}

/** Resolves the progressive Community Hunt milestone target and celebration badge. */
export function getCommunityHuntStatus(count: number): CommunityHuntStatus {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  let badgeLabel: string | null = null;
  if (safeCount >= COMMUNITY_HUNT_TIERS[2]) {
    badgeLabel = '🥇 Dragon Vanquished!';
  } else if (safeCount >= COMMUNITY_HUNT_TIERS[1]) {
    badgeLabel = '🥈 Silver Dragon Slayers';
  } else if (safeCount >= COMMUNITY_HUNT_TIERS[0]) {
    badgeLabel = '🥉 Bronze Dragon Slayers';
  }

  let target: number = COMMUNITY_HUNT_TIERS[2];
  if (safeCount < COMMUNITY_HUNT_TIERS[0]) {
    target = COMMUNITY_HUNT_TIERS[0];
  } else if (safeCount < COMMUNITY_HUNT_TIERS[1]) {
    target = COMMUNITY_HUNT_TIERS[1];
  }
  return { count: safeCount, target, badgeLabel };
}

/** Returns milliseconds remaining until the next 00:00 UTC daily reset. */
export function msUntilNextUtcMidnight(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(0, nextMidnight - nowMs);
}

/** Formats milliseconds until 00:00 UTC reset as compact `Xh Ym` or `<1m`. */
export function formatUtcResetCountdown(msRemaining: number): string {
  const totalMinutes = Math.max(0, Math.floor(msRemaining / 60_000));
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

/**
 * Leaderboard ordering:
 * 1. More Wins
 * 2. Fewer total turns across winning games
 * 3. First Try ⭐ bonus priority
 * 4. Earlier completion timestamp
 */
export function compareRuns(a: RunResult, b: RunResult): number {
  if (a.wins !== b.wins) return b.wins - a.wins;
  if (a.totalTurns !== b.totalTurns) return a.totalTurns - b.totalTurns;
  if (a.firstTry !== b.firstTry) return a.firstTry ? -1 : 1;
  return a.completedAtMs - b.completedAtMs;
}
