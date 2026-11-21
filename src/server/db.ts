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

export interface PlayerIdentity {
  readonly playerKey: string;
  readonly username: string;
  readonly isGuest: boolean;
}

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
    };
  }

  const safeGuest =
    (guestId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const cleanNick = sanitizeDisplayName(guestNickname) || 'Guest';
  return {
    playerKey: `guest:${safeGuest}`,
    username: cleanNick,
    isGuest: true,
  };
}

function sanitizeDisplayName(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\r\n\t<>@]/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .trim()
    .slice(0, 24);
}

export async function dbGetCommunityHuntCount(dayKey: string): Promise<number> {
  const raw = await redis.get(communityHuntKey(dayKey));
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function dbRecordCommunityHuntWin(
  dayKey: string,
  playerKey: string,
  isGuest: boolean,
): Promise<{ readonly count: number; readonly incremented: boolean }> {
  if (isGuest) {
    return { count: await dbGetCommunityHuntCount(dayKey), incremented: false };
  }
  const memberKey = `hunt:${dayKey}:member:${playerKey}`;
  const alreadyCounted = await redis.get(memberKey);
  if (alreadyCounted === '1') {
    return { count: await dbGetCommunityHuntCount(dayKey), incremented: false };
  }
  await redis.set(memberKey, '1');
  const count = await redis.incrBy(communityHuntKey(dayKey), 1);
  return { count, incremented: true };
}

export async function dbGetAttemptCount(
  dayKey: string,
  playerKey: string,
): Promise<number> {
  const raw = await redis.get(attemptsKey(dayKey, playerKey));
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function dbClaimAttempt(
  dayKey: string,
  playerKey: string,
): Promise<{ readonly attemptNumber: number; readonly firstTry: boolean }> {
  const attemptNumber = await redis.incrBy(attemptsKey(dayKey, playerKey), 1);
  return {
    attemptNumber,
    firstTry: attemptNumber === 1,
  };
}

export async function dbGetActiveRun(
  dayKey: string,
  playerKey: string,
): Promise<RunState | null> {
  const runId = await redis.get(currentRunPointerKey(dayKey, playerKey));
  if (!runId) return null;
  return dbGetRunById(runId);
}

export async function dbGetRunById(runId: string): Promise<RunState | null> {
  const raw = await redis.get(runRecordKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export async function dbSaveRun(run: RunState): Promise<void> {
  await redis.set(runRecordKey(run.runId), JSON.stringify(run));
  await redis.set(currentRunPointerKey(run.dayKey, run.playerKey), run.runId);
}

export async function dbRecordStageAttempt(
  dayKey: string,
  stage: number,
  bossId: BossId,
): Promise<void> {
  const current = await readStageEpitaph(dayKey, stage, bossId);
  const updated: StageEpitaph = {
    ...current,
    attempts: current.attempts + 1,
  };
  await writeStageEpitaph(dayKey, updated);
}

export async function dbRecordStageDeath(
  dayKey: string,
  stage: number,
  bossId: BossId,
  username: string,
  turns: number,
): Promise<void> {
  const current = await readStageEpitaph(dayKey, stage, bossId);
  const nextAttempts = Math.max(current.attempts, current.losses + 1);
  const nextLosses = current.losses + 1;
  const updated: StageEpitaph = {
    stage,
    bossId,
    attempts: nextAttempts,
    losses: nextLosses,
    eliminationRatePct: Math.min(
      100,
      Math.round((nextLosses / nextAttempts) * 100),
    ),
    lastFallenUser: username,
    lastFallenTurns: turns,
  };
  await writeStageEpitaph(dayKey, updated);
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

export async function dbRecordLeaderboardRun(
  run: RunState,
  nowMs: number,
): Promise<{ readonly dailyRank: number | null }> {
  const completedAtMs = run.completedAtMs ?? nowMs;
  const candidate: LeaderboardEntry = {
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
  const nowPeriods = allPeriodKeys(nowMs);

  let dailyRank: number | null = null;
  if (runPeriods.day === nowPeriods.day) {
    const dailyList = await upsertPeriodLeaderboard(
      leaderboardKey('day', runPeriods.day),
      candidate,
    );
    const idx = dailyList.findIndex(
      (entry) => entry.playerKey === candidate.playerKey,
    );
    dailyRank = idx >= 0 ? idx + 1 : null;
  }

  if (runPeriods.week === nowPeriods.week) {
    await upsertPeriodLeaderboard(
      leaderboardKey('week', runPeriods.week),
      candidate,
    );
  }
  if (runPeriods.month === nowPeriods.month) {
    await upsertPeriodLeaderboard(
      leaderboardKey('month', runPeriods.month),
      candidate,
    );
  }
  if (runPeriods.year === nowPeriods.year) {
    await upsertPeriodLeaderboard(
      leaderboardKey('year', runPeriods.year),
      candidate,
    );
  }

  return { dailyRank };
}

export async function dbGetDailyRank(
  dayKey: string,
  playerKey: string,
): Promise<number | null> {
  const entries = await readLeaderboard(leaderboardKey('day', dayKey));
  const idx = entries.findIndex((entry) => entry.playerKey === playerKey);
  return idx >= 0 ? idx + 1 : null;
}

export async function dbGetLeaderboards(
  nowMs: number,
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
    day,
    week,
    month,
    year,
  };
}

async function readStageEpitaph(
  dayKey: string,
  stage: number,
  bossId: BossId,
): Promise<StageEpitaph> {
  const raw = await redis.get(epitaphKey(dayKey, stage));
  if (raw) {
    try {
      return JSON.parse(raw) as StageEpitaph;
    } catch {
      // Fall back to empty epitaph if corrupted.
    }
  }
  return {
    stage,
    bossId,
    attempts: 0,
    losses: 0,
    eliminationRatePct: 0,
  };
}

async function writeStageEpitaph(
  dayKey: string,
  epitaph: StageEpitaph,
): Promise<void> {
  await redis.set(epitaphKey(dayKey, epitaph.stage), JSON.stringify(epitaph));
}

async function readLeaderboard(key: string): Promise<LeaderboardEntry[]> {
  const raw = await redis.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LeaderboardEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function upsertPeriodLeaderboard(
  key: string,
  candidate: LeaderboardEntry,
): Promise<LeaderboardEntry[]> {
  const list = await readLeaderboard(key);
  const existingIdx = list.findIndex(
    (entry) => entry.playerKey === candidate.playerKey,
  );
  if (existingIdx >= 0) {
    const existing = list[existingIdx]!;
    if (compareRuns(candidate, existing) >= 0) {
      return list;
    }
    list[existingIdx] = candidate;
  } else {
    list.push(candidate);
  }
  list.sort(compareRuns);
  const trimmed = list.slice(0, LEADERBOARD_LIMIT);
  await redis.set(key, JSON.stringify(trimmed));
  return trimmed;
}

function communityHuntKey(dayKey: string): string {
  return `hunt:${dayKey}:count`;
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
