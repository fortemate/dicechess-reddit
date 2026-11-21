import { redis } from '@devvit/web/server';
import type {
  LeaderboardEntry,
  LeaderboardsBundle,
  RunState,
  StageEpitaph,
} from '../shared/api.ts';
import {
  allPeriodKeys,
  compareRuns,
  GAUNTLET_LADDER,
  getStageOpponent,
  type BossId,
} from '../shared/daily.ts';

export const DEFAULT_HUNT_TARGET = 10;
const LEADERBOARD_LIMIT = 50;
const TX_MAX_RETRIES = 12;
const GUEST_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export interface PlayerIdentity {
  readonly playerKey: string;
  readonly username: string;
  readonly isGuest: boolean;
  readonly isAuthenticated: boolean;
  readonly hasValidGuestId: boolean;
}

export type StoredRunState = RunState & {
  readonly playerKey: string;
};

type StoredLeaderboardEntry = Omit<LeaderboardEntry, 'isViewer'> & {
  readonly playerKey: string;
  readonly runId?: string;
};

/** Resolves Reddit or guest identity from context + request metadata. */
export function resolvePlayerIdentity(
  userId: string | undefined,
  redditUsername: string | undefined,
  guestId?: string,
  guestNickname?: string,
): PlayerIdentity {
  if (userId) {
    const cleanName = sanitizeDisplayName(redditUsername) || 'Redditor';
    return {
      playerKey: `user:${userId}`,
      username: cleanName,
      isGuest: false,
      isAuthenticated: true,
      hasValidGuestId: false,
    };
  }

  const trimmedGuest = (guestId ?? '').trim();
  const hasValidGuestId = GUEST_ID_RE.test(trimmedGuest);
  const safeGuest = hasValidGuestId ? trimmedGuest : 'anon';
  const cleanNick = sanitizeDisplayName(guestNickname) || 'Guest';
  return {
    playerKey: `guest:${safeGuest}`,
    username: cleanNick,
    isGuest: true,
    isAuthenticated: false,
    hasValidGuestId,
  };
}

/** Strips internal `playerKey` before serializing a RunState to API callers. */
export function toPublicRunState(run: StoredRunState): RunState {
  const { playerKey: _omitted, ...publicRun } = run;
  return publicRun;
}

function sanitizeDisplayName(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replaceAll(/[\r\n\t<>@]/g, '')
    .replaceAll(/https?:\/\/\S+/gi, '')
    .trim()
    .slice(0, 24);
}

/** Returns the count of distinct authenticated players who beat Stage 6 today. */
export function dbGetCommunityHuntCount(dayKey: string): Promise<number> {
  return redis.hLen(communityHuntKey(dayKey));
}

/** Atomically records a unique Reddit user's Stage 6 clear in a single Redis Hash. */
export async function dbRecordCommunityHuntWin(
  dayKey: string,
  playerKey: string,
  isGuest: boolean,
): Promise<{ readonly count: number; readonly incremented: boolean }> {
  if (isGuest || !playerKey.startsWith('user:')) {
    return { count: await dbGetCommunityHuntCount(dayKey), incremented: false };
  }
  const added = await redis.hSet(communityHuntKey(dayKey), {
    [playerKey]: '1',
  });
  const count = await dbGetCommunityHuntCount(dayKey);
  return { count, incremented: added > 0 };
}

export async function dbGetAttemptCount(
  dayKey: string,
  playerKey: string,
): Promise<number> {
  const raw = await redis.get(attemptsKey(dayKey, playerKey));
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function dbGetCurrentRunId(
  dayKey: string,
  playerKey: string,
): Promise<string | null> {
  return (await redis.get(currentRunPointerKey(dayKey, playerKey))) ?? null;
}

export async function dbGetActiveRun(
  dayKey: string,
  playerKey: string,
): Promise<StoredRunState | null> {
  const runId = await dbGetCurrentRunId(dayKey, playerKey);
  if (!runId) return null;
  return dbGetRunById(runId);
}

export async function dbGetRunById(
  runId: string,
): Promise<StoredRunState | null> {
  const raw = await redis.get(runRecordKey(runId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredRunState;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.runId !== 'string'
    ) {
      return null;
    }
    return {
      ...parsed,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
    };
  } catch {
    return null;
  }
}

/** Direct run persistence intended for seeding tests or initial setup. */
export async function dbSaveRun(run: StoredRunState): Promise<void> {
  await redis.set(runRecordKey(run.runId), JSON.stringify(run));
  await redis.set(currentRunPointerKey(run.dayKey, run.playerKey), run.runId);
}

/**
 * Optimistically commits an updated RunState only if stored `revision` matches
 * `expectedRevision` and a `finished` run is not transitioned to `finished` twice.
 */
export async function dbSaveRunCas(
  nextRun: StoredRunState,
  expectedRevision: number,
  options?: { readonly allowAlreadyFinished?: boolean },
): Promise<{
  readonly committed: boolean;
  readonly run: StoredRunState | null;
}> {
  const key = runRecordKey(nextRun.runId);
  for (let attempt = 0; attempt < TX_MAX_RETRIES; attempt += 1) {
    const txn = await redis.watch(key);
    const stored = await dbGetRunById(nextRun.runId);
    if (!stored) {
      await txn.unwatch();
      return { committed: false, run: null };
    }
    const alreadyTerminal =
      !options?.allowAlreadyFinished &&
      nextRun.status === 'finished' &&
      stored.status === 'finished';
    if (stored.revision !== expectedRevision || alreadyTerminal) {
      await txn.unwatch();
      return { committed: false, run: stored };
    }

    const bumped: StoredRunState = {
      ...nextRun,
      revision: expectedRevision + 1,
    };
    const committed = await executeWatchedSet(txn, key, JSON.stringify(bumped));
    if (committed) {
      return { committed: true, run: bumped };
    }
  }
  return { committed: false, run: await dbGetRunById(nextRun.runId) };
}

export type ClaimRunResult =
  | { readonly kind: 'existing'; readonly run: StoredRunState }
  | { readonly kind: 'created'; readonly run: StoredRunState };

export interface ClaimOrCreateRunParams {
  readonly dayKey: string;
  readonly playerKey: string;
  readonly forceNew: boolean;
  readonly buildNewRun: (
    attemptNumber: number,
    firstTry: boolean,
  ) => StoredRunState;
  readonly onRetireExistingRun?: (existingRun: StoredRunState) => Promise<void>;
}

/**
 * Atomically resumes an existing non-finished run (when `!forceNew`) or claims the
 * next daily attempt number and stores a newly launched run in a single transaction.
 */
export async function dbClaimOrCreateRun(
  params: ClaimOrCreateRunParams,
): Promise<ClaimRunResult> {
  return claimOrCreateRunWithRetry(params, TX_MAX_RETRIES);
}

async function claimOrCreateRunWithRetry(
  params: ClaimOrCreateRunParams,
  remainingAttempts: number,
): Promise<ClaimRunResult> {
  if (remainingAttempts <= 0) {
    throw new Error(
      'Could not claim daily gauntlet run due to high contention',
    );
  }
  const outcome = await tryClaimOrCreateRunOnce(params);
  if (outcome !== null) {
    return outcome;
  }
  return claimOrCreateRunWithRetry(params, remainingAttempts - 1);
}

async function tryClaimOrCreateRunOnce(
  params: ClaimOrCreateRunParams,
): Promise<ClaimRunResult | null> {
  const pointerKey = currentRunPointerKey(params.dayKey, params.playerKey);
  const attKey = attemptsKey(params.dayKey, params.playerKey);
  const txn = await redis.watch(pointerKey, attKey);
  const [existingRunId, attRaw] = await Promise.all([
    redis.get(pointerKey),
    redis.get(attKey),
  ]);
  const existing = existingRunId ? await dbGetRunById(existingRunId) : null;

  if (existing && !params.forceNew && existing.status !== 'finished') {
    await txn.unwatch();
    return { kind: 'existing', run: existing };
  }

  if (
    existing &&
    params.forceNew &&
    existing.status !== 'finished' &&
    params.onRetireExistingRun
  ) {
    await txn.unwatch();
    await params.onRetireExistingRun(existing);
    return null;
  }

  const currentAttempts = Number(attRaw ?? 0);
  const nextAttempt =
    (Number.isFinite(currentAttempts) && currentAttempts >= 0
      ? currentAttempts
      : 0) + 1;
  const candidateRun: StoredRunState = {
    ...params.buildNewRun(nextAttempt, nextAttempt === 1),
    revision: 1,
  };

  try {
    await txn.multi();
    await txn.set(
      runRecordKey(candidateRun.runId),
      JSON.stringify(candidateRun),
    );
    await txn.set(pointerKey, candidateRun.runId);
    await txn.set(attKey, String(nextAttempt));
    const results = await txn.exec();
    return isTxAborted(results, 3)
      ? null
      : { kind: 'created', run: candidateRun };
  } catch (err) {
    await txn.discard().catch(() => undefined);
    if (!isWatchConflictError(err)) {
      throw err;
    }
    return null;
  }
}

export async function dbRecordStageAttempt(
  dayKey: string,
  stage: number,
): Promise<void> {
  await redis.hIncrBy(epitaphKey(dayKey, stage), 'attempts', 1);
}

export async function dbRecordStageDeath(
  dayKey: string,
  stage: number,
  username: string,
  turns: number,
): Promise<void> {
  const key = epitaphKey(dayKey, stage);
  await Promise.all([
    redis.hIncrBy(key, 'losses', 1),
    redis.hSet(key, {
      lastFallenUser: username,
      lastFallenTurns: String(turns),
    }),
  ]);
}

export async function dbGetStageEpitaph(
  dayKey: string,
  stage: number,
): Promise<StageEpitaph> {
  const opp = getStageOpponent(stage);
  return readStageEpitaph(dayKey, stage, opp.boss.id);
}

export async function dbGetStageEpitaphs(
  dayKey: string,
): Promise<readonly StageEpitaph[]> {
  return Promise.all(
    GAUNTLET_LADDER.map((boss) =>
      readStageEpitaph(dayKey, boss.stage, boss.id),
    ),
  );
}

/**
 * Atomically records a run across the day/week/month/year leaderboards matching
 * `run.dayKey`. Returns `dailyRank` only when this run matches or holds the player's
 * best daily leaderboard entry (never reusing an earlier better run's rank).
 */
export async function dbRecordLeaderboardRun(
  run: StoredRunState,
  nowMs: number,
): Promise<{ readonly dailyRank: number | null }> {
  const completedAtMs = run.completedAtMs ?? nowMs;
  const isFinished = run.status === 'finished';
  const candidate: StoredLeaderboardEntry = {
    runId: run.runId,
    playerKey: run.playerKey,
    username: run.username,
    isGuest: run.isGuest,
    wins: run.wins,
    totalTurns: run.totalTurns,
    firstTry: run.firstTry,
    dayKey: run.dayKey,
    maxStage: run.currentStage,
    completedAtMs,
  };

  const runPeriods = allPeriodKeys(Date.parse(`${run.dayKey}T00:00:00.000Z`));

  const dailyOutcome = await upsertPeriodLeaderboard(
    leaderboardKey('day', runPeriods.day),
    candidate,
    isFinished,
  );

  await Promise.all([
    upsertPeriodLeaderboard(
      leaderboardKey('week', runPeriods.week),
      candidate,
      isFinished,
    ),
    upsertPeriodLeaderboard(
      leaderboardKey('month', runPeriods.month),
      candidate,
      isFinished,
    ),
    upsertPeriodLeaderboard(
      leaderboardKey('year', runPeriods.year),
      candidate,
      isFinished,
    ),
  ]);

  if (!dailyOutcome.matchedCandidate) {
    return { dailyRank: null };
  }
  const idx = dailyOutcome.entries.findIndex(
    (entry) => entry.playerKey === candidate.playerKey,
  );
  return { dailyRank: idx >= 0 ? idx + 1 : null };
}

export async function dbGetLeaderboards(
  nowMs: number,
  viewerPlayerKey?: string,
): Promise<LeaderboardsBundle> {
  const keys = allPeriodKeys(nowMs);
  const [day, week, month, year] = await Promise.all([
    readLeaderboard(leaderboardKey('day', keys.day)),
    readLeaderboard(leaderboardKey('week', keys.week)),
    readLeaderboard(leaderboardKey('month', keys.month)),
    readLeaderboard(leaderboardKey('year', keys.year)),
  ]);
  return {
    dayKey: keys.day,
    weekKey: keys.week,
    monthKey: keys.month,
    yearKey: keys.year,
    day: toPublicLeaderboard(day, viewerPlayerKey),
    week: toPublicLeaderboard(week, viewerPlayerKey),
    month: toPublicLeaderboard(month, viewerPlayerKey),
    year: toPublicLeaderboard(year, viewerPlayerKey),
  };
}

function toPublicLeaderboard(
  entries: readonly StoredLeaderboardEntry[],
  viewerPlayerKey?: string,
): LeaderboardEntry[] {
  return entries.map((entry) => {
    const { playerKey, runId: _runId, ...rest } = entry;
    return {
      ...rest,
      isViewer: Boolean(viewerPlayerKey && playerKey === viewerPlayerKey),
    };
  });
}

async function readStageEpitaph(
  dayKey: string,
  stage: number,
  bossId: BossId,
): Promise<StageEpitaph> {
  const hash = await redis.hGetAll(epitaphKey(dayKey, stage));
  const rawLosses = Number(hash.losses ?? 0);
  const losses = Number.isFinite(rawLosses) && rawLosses > 0 ? rawLosses : 0;
  const rawAttempts = Number(hash.attempts ?? 0);
  const parsedAttempts =
    Number.isFinite(rawAttempts) && rawAttempts > 0 ? rawAttempts : 0;
  const attempts = Math.max(parsedAttempts, losses);
  const eliminationRatePct =
    attempts > 0 ? Math.min(100, Math.round((losses / attempts) * 100)) : 0;

  if (!hash.lastFallenUser) {
    return { stage, bossId, attempts, losses, eliminationRatePct };
  }
  const rawTurns = Number(hash.lastFallenTurns ?? 0);
  return {
    stage,
    bossId,
    attempts,
    losses,
    eliminationRatePct,
    lastFallenUser: hash.lastFallenUser,
    lastFallenTurns: Number.isFinite(rawTurns) ? rawTurns : 0,
  };
}

async function readLeaderboard(key: string): Promise<StoredLeaderboardEntry[]> {
  const raw = await redis.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredLeaderboardEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type LeaderboardMergeResult =
  | {
      readonly changed: false;
      readonly entries: StoredLeaderboardEntry[];
      readonly matchedCandidate: boolean;
    }
  | {
      readonly changed: true;
      readonly entries: StoredLeaderboardEntry[];
      readonly matchedCandidate: boolean;
    };

function mergeLeaderboardEntry(
  list: StoredLeaderboardEntry[],
  candidate: StoredLeaderboardEntry,
  isFinished: boolean,
): LeaderboardMergeResult {
  const existingIdx = list.findIndex(
    (entry) => entry.playerKey === candidate.playerKey,
  );
  if (existingIdx < 0) {
    list.push(candidate);
  } else {
    const existing = list[existingIdx]!;
    const sameRun =
      existing.runId !== undefined && existing.runId === candidate.runId;
    if (compareRuns(candidate, existing) >= 0) {
      const needsTimestamp =
        sameRun &&
        isFinished &&
        existing.completedAtMs !== candidate.completedAtMs;
      const needsStage = sameRun && existing.maxStage < candidate.maxStage;
      if (!needsTimestamp && !needsStage) {
        return { changed: false, entries: list, matchedCandidate: sameRun };
      }
      list[existingIdx] = {
        ...existing,
        maxStage: Math.max(existing.maxStage, candidate.maxStage),
        completedAtMs: needsTimestamp
          ? candidate.completedAtMs
          : existing.completedAtMs,
      };
    } else {
      list[existingIdx] = candidate;
    }
  }

  list.sort(compareRuns);
  const trimmed = list.slice(0, LEADERBOARD_LIMIT);
  const stillIncluded = trimmed.some(
    (entry) => entry.playerKey === candidate.playerKey,
  );
  return {
    changed: true,
    entries: trimmed,
    matchedCandidate: stillIncluded,
  };
}

async function tryUpsertPeriodLeaderboardOnce(
  key: string,
  candidate: StoredLeaderboardEntry,
  isFinished: boolean,
): Promise<{
  readonly entries: StoredLeaderboardEntry[];
  readonly matchedCandidate: boolean;
} | null> {
  const txn = await redis.watch(key);
  const list = await readLeaderboard(key);
  const merged = mergeLeaderboardEntry(list, candidate, isFinished);
  if (!merged.changed) {
    await txn.unwatch();
    return {
      entries: merged.entries,
      matchedCandidate: merged.matchedCandidate,
    };
  }
  const written = await executeWatchedSet(
    txn,
    key,
    JSON.stringify(merged.entries),
  );
  return written
    ? { entries: merged.entries, matchedCandidate: merged.matchedCandidate }
    : null;
}

async function upsertPeriodLeaderboard(
  key: string,
  candidate: StoredLeaderboardEntry,
  isFinished: boolean,
  remainingAttempts = TX_MAX_RETRIES,
): Promise<{
  readonly entries: StoredLeaderboardEntry[];
  readonly matchedCandidate: boolean;
}> {
  if (remainingAttempts <= 0) {
    throw new Error(
      `Could not update leaderboard "${key}" due to high contention`,
    );
  }
  const committed = await tryUpsertPeriodLeaderboardOnce(
    key,
    candidate,
    isFinished,
  );
  if (committed !== null) {
    return committed;
  }
  return upsertPeriodLeaderboard(
    key,
    candidate,
    isFinished,
    remainingAttempts - 1,
  );
}

async function executeWatchedSet(
  txn: Awaited<ReturnType<typeof redis.watch>>,
  key: string,
  value: string,
): Promise<boolean> {
  try {
    await txn.multi();
    await txn.set(key, value);
    const results = await txn.exec();
    return !isTxAborted(results, 1);
  } catch (err) {
    await txn.discard().catch(() => undefined);
    if (isWatchConflictError(err)) {
      return false;
    }
    throw err;
  }
}

function isTxAborted(
  results: unknown[] | null | undefined,
  expectedCount: number,
): boolean {
  if (results == null) return true;
  return expectedCount > 0 && results.length === 0;
}

function isWatchConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /watch|abort|conflict|transaction/i.test(err.message)
  );
}

function communityHuntKey(dayKey: string): string {
  return `hunt:${dayKey}:members`;
}

function attemptsKey(dayKey: string, playerKey: string): string {
  return `attempts:${dayKey}:${playerKey}`;
}

function currentRunPointerKey(dayKey: string, playerKey: string): string {
  return `run:current:${dayKey}:${playerKey}`;
}

function runRecordKey(runId: string): string {
  return `run:id:${runId}`;
}

function epitaphKey(dayKey: string, stage: number): string {
  return `epitaph:${dayKey}:stage:${stage}`;
}

function leaderboardKey(
  period: 'day' | 'week' | 'month' | 'year',
  periodKey: string,
): string {
  return `lb:${period}:${periodKey}`;
}
