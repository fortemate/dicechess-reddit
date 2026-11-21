import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  type Context,
  redis,
  reddit,
  runWithContext,
} from '@devvit/web/server';
import {
  Endpoint,
  type ErrorRsp,
  type GetDailyStateRsp,
  type LeaderboardsBundle,
  type PauseRunRsp,
  type ResignRunRsp,
  type ShareCommentRsp,
  type StartRunRsp,
  type SubmitTurnRsp,
} from '../shared/api.ts';
import {
  getStageOpponent,
  STANDARD_START_FEN,
  utcDayKey,
} from '../shared/daily.ts';
import { chooseBotTurn } from '../shared/engine.ts';
import { dbSaveRun, type StoredRunState } from './db.ts';
import { createAppHandler } from './server.ts';

let server: Server;
let serverURL: string;
let mockNowMs = Date.parse('2026-11-21T12:00:00.000Z');
let mockUser: { userId?: string; username?: string } = {
  userId: 't2_alice',
  username: 'alice_chess',
};
const postedComments: Array<{ id: string; text: string }> = [];

const redisStore = new Map<string, string>();
const hashStore = new Map<string, Map<string, string>>();
const keyVersions = new Map<string, number>();

const originalGet = redis.get.bind(redis);
const originalSet = redis.set.bind(redis);
const originalIncrBy = redis.incrBy.bind(redis);
const originalHSet = redis.hSet.bind(redis);
const originalHIncrBy = redis.hIncrBy.bind(redis);
const originalHGetAll = redis.hGetAll.bind(redis);
const originalHLen = redis.hLen.bind(redis);
const originalWatch = redis.watch.bind(redis);
const originalSubmitComment = reddit.submitComment.bind(reddit);

function bumpKeyVersion(key: string): void {
  keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
}

function syncSet(key: string, value: string): string {
  redisStore.set(key, value);
  bumpKeyVersion(key);
  return 'OK';
}

function syncIncrBy(key: string, amount: number): number {
  const next = Number(redisStore.get(key) ?? '0') + amount;
  redisStore.set(key, `${next}`);
  bumpKeyVersion(key);
  return next;
}

function syncHSet(key: string, fieldValues: Record<string, string>): number {
  const map = getHashMap(key);
  let added = 0;
  for (const [field, value] of Object.entries(fieldValues)) {
    if (!map.has(field)) added += 1;
    map.set(field, value);
  }
  bumpKeyVersion(key);
  return added;
}

function syncHIncrBy(key: string, field: string, amount: number): number {
  const map = getHashMap(key);
  const next = Number(map.get(field) ?? '0') + amount;
  map.set(field, `${next}`);
  bumpKeyVersion(key);
  return next;
}

function getHashMap(key: string): Map<string, string> {
  let map = hashStore.get(key);
  if (!map) {
    map = new Map<string, string>();
    hashStore.set(key, map);
  }
  return map;
}

async function postJson<T>(
  endpoint: string,
  body: unknown,
): Promise<{
  status: number;
  data: T;
}> {
  const rsp = await fetch(`${serverURL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await rsp.json()) as T;
  return { status: rsp.status, data };
}

describe('Devvit Web server endpoints & full gauntlet lifecycle', () => {
  before(async () => {
    redis.get = async (key) => {
      await Promise.resolve();
      return redisStore.get(key);
    };
    redis.set = async (key, value) => syncSet(key, value);
    redis.incrBy = async (key, amount) => syncIncrBy(key, amount);
    redis.hSet = async (key, fieldValues) => syncHSet(key, fieldValues);
    redis.hIncrBy = async (key, field, amount) =>
      syncHIncrBy(key, field, amount);
    redis.hGetAll = async (key) => {
      const map = hashStore.get(key);
      return map ? Object.fromEntries(map.entries()) : {};
    };
    redis.hLen = async (key) => {
      return hashStore.get(key)?.size ?? 0;
    };
    redis.watch = (async (...keys: string[]) => {
      const watched = new Map<string, number>();
      for (const key of keys) {
        watched.set(key, keyVersions.get(key) ?? 0);
      }
      let multiStarted = false;
      const queued: Array<() => unknown> = [];

      const tx = {
        async multi() {
          multiStarted = true;
        },
        async set(key: string, value: string) {
          queued.push(() => syncSet(key, value));
          return tx;
        },
        async incrBy(key: string, amount: number) {
          queued.push(() => syncIncrBy(key, amount));
          return tx;
        },
        async hSet(key: string, fieldValues: Record<string, string>) {
          queued.push(() => syncHSet(key, fieldValues));
          return tx;
        },
        async hIncrBy(key: string, field: string, amount: number) {
          queued.push(() => syncHIncrBy(key, field, amount));
          return tx;
        },
        async del(...delKeys: string[]) {
          queued.push(() => {
            for (const dk of delKeys) {
              redisStore.delete(dk);
              hashStore.delete(dk);
              bumpKeyVersion(dk);
            }
            return delKeys.length;
          });
          return tx;
        },
        async unwatch() {
          watched.clear();
          queued.length = 0;
          return tx;
        },
        async discard() {
          multiStarted = false;
          watched.clear();
          queued.length = 0;
        },
        async watch(...moreKeys: string[]) {
          for (const key of moreKeys) {
            watched.set(key, keyVersions.get(key) ?? 0);
          }
          return tx;
        },
        async exec() {
          if (!multiStarted) {
            throw new Error('Must call multi() before exec()');
          }
          for (const [key, version] of watched.entries()) {
            if ((keyVersions.get(key) ?? 0) !== version) {
              return [];
            }
          }
          return queued.map((op) => op());
        },
      };
      return tx as unknown as Awaited<ReturnType<typeof redis.watch>>;
    }) as typeof redis.watch;

    reddit.submitComment = (async (opts: { id: string; text: string }) => {
      postedComments.push({ id: opts.id, text: opts.text });
      return {} as never;
    }) as typeof reddit.submitComment;

    const handler = createAppHandler({
      now: () => mockNowMs,
      random: () => 0.1,
    });

    server = createServer(async (req, rsp) => {
      await runWithContext(
        {
          appName: 'dicechess-daily',
          postId: 't3_daily1',
          userId: mockUser.userId,
          username: mockUser.username,
        } as unknown as Context,
        () => handler(req, rsp),
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const info = server.address() as AddressInfo;
    serverURL = `http://127.0.0.1:${info.port}`;
  });

  after(async () => {
    redis.get = originalGet;
    redis.set = originalSet;
    redis.incrBy = originalIncrBy;
    redis.hSet = originalHSet;
    redis.hIncrBy = originalHIncrBy;
    redis.hGetAll = originalHGetAll;
    redis.hLen = originalHLen;
    redis.watch = originalWatch;
    reddit.submitComment = originalSubmitComment;
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    redisStore.clear();
    hashStore.clear();
    keyVersions.clear();
    postedComments.length = 0;
    mockNowMs = Date.parse('2026-11-21T12:00:00.000Z');
    mockUser = { userId: 't2_alice', username: 'alice_chess' };
  });

  it('returns daily state with P+2 opening roll, Ashby boss, 3+2 clock, and hunt count without exposing playerKey', async () => {
    const today = utcDayKey(mockNowMs);
    await redis.hSet(`hunt:${today}:members`, {
      u1: '1',
      u2: '1',
      u3: '1',
      u4: '1',
    });

    const rsp = await fetch(`${serverURL}/${Endpoint.GetDailyState}`);
    assert.equal(rsp.status, 200);
    assert.equal(rsp.headers.get('Content-Type'), 'application/json');

    const body = (await rsp.json()) as GetDailyStateRsp;
    assert.equal(body.dayKey, today);
    assert.equal(body.serverNowMs, mockNowMs);
    assert.ok(body.openingRoll.includes('P'));
    assert.equal(body.dailyBoss.id, 'ashby');
    assert.equal(body.initialClockMs, 180_000);
    assert.equal(body.incrementMs, 2_000);
    assert.equal(body.communityHuntCount, 4);
    assert.equal(body.playerUsername, 'alice_chess');
    assert.equal(body.isGuest, false);
  });

  it('awards First Try on attempt 1, prevents duplicate concurrent starts, and drops First Try on attempt 2', async () => {
    const [concurrent1, concurrent2] = await Promise.all([
      postJson<StartRunRsp>(Endpoint.StartRun, {}),
      postJson<StartRunRsp>(Endpoint.StartRun, {}),
    ]);
    assert.equal(concurrent1.status, 200);
    assert.equal(concurrent2.status, 200);
    assert.equal(concurrent1.data.run.runId, concurrent2.data.run.runId);
    assert.equal(concurrent1.data.run.firstTry, true);
    assert.equal(concurrent1.data.run.attemptNumber, 1);
    assert.equal(concurrent1.data.run.status, 'in_game');
    assert.equal(
      'playerKey' in
        (concurrent1.data.run as unknown as Record<string, unknown>),
      false,
    );
    assert.notEqual(concurrent1.data.resumed, concurrent2.data.resumed);

    // Resigning finishes attempt 1 and records a Stage 1 epitaph.
    const resign = await postJson<ResignRunRsp>(Endpoint.ResignRun, {
      runId: concurrent1.data.run.runId,
    });
    assert.equal(resign.status, 200);
    assert.equal(resign.data.run.status, 'finished');
    assert.ok(resign.data.run.shareCardText);

    // Attempt 2 starts cleanly without the First Try badge.
    const start2 = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    assert.equal(start2.status, 200);
    assert.equal(start2.data.resumed, false);
    assert.equal(start2.data.run.attemptNumber, 2);
    assert.equal(start2.data.run.firstTry, false);

    const daily = (await (
      await fetch(`${serverURL}/${Endpoint.GetDailyState}`)
    ).json()) as GetDailyStateRsp;
    assert.equal(daily.stageEpitaphs[0]?.losses, 1);
    assert.equal(daily.stageEpitaphs[0]?.lastFallenUser, 'alice_chess');
  });

  it('validates turns, rejects partial turns & stale gameInstanceId, increments clock by +2s, detects timeout, and blocks pausing mid-game', async () => {
    const start = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    const game = start.data.run.activeGame!;
    assert.equal(game.plyNumber, 1);

    // Pausing during an active game is forbidden.
    const midPause = await postJson<ErrorRsp>(Endpoint.PauseRun, {
      runId: start.data.run.runId,
    });
    assert.equal(midPause.status, 400);

    // Partial turn submission (only 1 micro-move when 3 legal dice exist) must be rejected.
    const partialTurn = await postJson<ErrorRsp>(Endpoint.SubmitTurn, {
      runId: start.data.run.runId,
      gameInstanceId: game.gameInstanceId,
      plyNumber: 1,
      moves: ['e2e3'],
    });
    assert.equal(partialTurn.status, 400);

    // Stale gameInstanceId must be rejected with 409.
    const staleInstance = await postJson<ErrorRsp>(Endpoint.SubmitTurn, {
      runId: start.data.run.runId,
      gameInstanceId: 'wrong-instance-id',
      plyNumber: 1,
      moves: ['e2e3'],
    });
    assert.equal(staleInstance.status, 409);

    // Play a valid turn using the engine's legal moves after 5 seconds of thinking.
    mockNowMs += 5_000;
    const legalTurn = chooseBotTurn(
      STANDARD_START_FEN,
      game.currentRoll,
      'greedy',
    );
    const turnRsp = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: start.data.run.runId,
      gameInstanceId: game.gameInstanceId,
      plyNumber: 1,
      moves: legalTurn,
    });
    assert.equal(turnRsp.status, 200);
    assert.equal(turnRsp.data.run.activeGame?.plyNumber, 3);
    assert.equal(
      turnRsp.data.run.activeGame?.playerRemainingMs,
      180_000 - 5_000 + 2_000,
    );

    // Advance clock past remaining time -> server declares timeout loss.
    mockNowMs += 200_000;
    const timeoutRsp = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: start.data.run.runId,
      gameInstanceId: turnRsp.data.run.activeGame!.gameInstanceId,
      plyNumber: 3,
      moves: [],
    });
    assert.equal(timeoutRsp.status, 200);
    assert.equal(timeoutRsp.data.stageOutcome, 'loss');
    assert.equal(timeoutRsp.data.outcomeReason, 'timeout');
    assert.equal(timeoutRsp.data.run.status, 'finished');
  });

  it('advances stage on win, increments Ashby hunt on Stage 6, holds stage on draw, and avoids leaking earlier rank onto weaker runs', async () => {
    const start = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    const run = start.data.run;

    // Seed a Stage 6 position where Black (player) can capture Ashby's White King on e1 immediately.
    const stage6Run: StoredRunState = {
      ...run,
      playerKey: 'user:t2_alice',
      currentStage: 6,
      wins: 5,
      totalTurns: 40,
      activeGame: {
        ...run.activeGame!,
        stage: 6,
        opponent: getStageOpponent(6),
        baseFen: '4k3/8/8/8/4q3/8/8/4K3 b - - 0 1',
        plyNumber: 2,
        playerTurnCount: 1,
        currentRoll: ['P', 'Q', 'K'] as const,
        turnStartedAtMs: mockNowMs,
      },
    };
    await dbSaveRun(stage6Run);

    mockNowMs += 1_000;
    const winRsp = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: run.runId,
      gameInstanceId: run.activeGame!.gameInstanceId,
      plyNumber: 2,
      moves: ['e4e1'],
    });
    assert.equal(winRsp.status, 200);
    assert.equal(winRsp.data.stageOutcome, 'win');
    assert.equal(winRsp.data.run.wins, 6);
    assert.equal(winRsp.data.run.currentStage, 7);
    assert.equal(winRsp.data.run.status, 'paused_between_games');
    assert.equal(winRsp.data.communityHuntCount, 1);

    // Pause between games succeeds when paused_between_games.
    const pauseRsp = await postJson<PauseRunRsp>(Endpoint.PauseRun, {
      runId: run.runId,
    });
    assert.equal(pauseRsp.status, 200);
    assert.equal(pauseRsp.data.run.status, 'paused_between_games');

    // Resume into Stage 7 (Ascended Gauntlet) and trigger a 100-halfmove draw.
    const resumed = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    assert.equal(resumed.data.resumed, true);
    assert.equal(resumed.data.run.currentStage, 7);

    const drawStage7: StoredRunState = {
      ...resumed.data.run,
      playerKey: 'user:t2_alice',
      activeGame: {
        ...resumed.data.run.activeGame!,
        baseFen: '4k3/8/8/8/8/8/8/4K3 w - - 99 50',
        plyNumber: 100,
        playerTurnCount: 0,
        currentRoll: ['K', 'P', 'P'] as const,
        turnStartedAtMs: mockNowMs,
      },
    };
    await dbSaveRun(drawStage7);

    const drawRsp = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: run.runId,
      gameInstanceId: resumed.data.run.activeGame!.gameInstanceId,
      plyNumber: 100,
      moves: ['e1d1'],
    });
    assert.equal(drawRsp.status, 200);
    assert.equal(drawRsp.data.stageOutcome, 'draw');
    assert.equal(drawRsp.data.run.wins, 6);
    assert.equal(drawRsp.data.run.currentStage, 7);
    assert.equal(drawRsp.data.run.status, 'paused_between_games');

    // Verify all 4 leaderboard periods contain Alice's 6-win run with isViewer=true and no playerKey.
    const lbs = (await (
      await fetch(`${serverURL}/${Endpoint.GetLeaderboards}`)
    ).json()) as LeaderboardsBundle;
    assert.equal(lbs.day[0]?.username, 'alice_chess');
    assert.equal(lbs.day[0]?.wins, 6);
    assert.equal(lbs.day[0]?.isViewer, true);
    assert.equal(
      'playerKey' in (lbs.day[0] as unknown as Record<string, unknown>),
      false,
    );
    assert.equal(lbs.week[0]?.wins, 6);
    assert.equal(lbs.month[0]?.wins, 6);
    assert.equal(lbs.year[0]?.wins, 6);

    // Resigning while paused_between_games finishes without recording a Stage 7 death.
    const resignRsp = await postJson<ResignRunRsp>(Endpoint.ResignRun, {
      runId: run.runId,
    });
    assert.equal(resignRsp.data.run.status, 'finished');
    assert.equal(resignRsp.data.run.dailyRank, 1);

    const shareRsp = await postJson<ShareCommentRsp>(Endpoint.ShareComment, {
      runId: run.runId,
    });
    assert.equal(shareRsp.status, 200);
    assert.equal(shareRsp.data.posted, true);
    assert.equal(postedComments.length, 1);
    assert.match(postedComments[0]!.text, /Ashby/);
    assert.match(postedComments[0]!.text, /Streak: 6 Wins/);

    // Attempt 2 resigns at Stage 1 (0 wins): must NOT inherit Attempt 1's #1 dailyRank on its share card.
    const attempt2 = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    const attempt2Resign = await postJson<ResignRunRsp>(Endpoint.ResignRun, {
      runId: attempt2.data.run.runId,
    });
    assert.equal(attempt2Resign.data.run.wins, 0);
    assert.equal(attempt2Resign.data.run.dailyRank, undefined);
    assert.doesNotMatch(
      attempt2Resign.data.run.shareCardText ?? '',
      /Rank #1 today/,
    );
  });

  it('requires valid Reddit or guest identity on mutating endpoints', async () => {
    mockUser = {};
    const badStart = await postJson<ErrorRsp>(Endpoint.StartRun, {});
    assert.equal(badStart.status, 400);

    const goodGuestStart = await postJson<StartRunRsp>(Endpoint.StartRun, {
      guestId: 'guest_valid_1234',
      guestNickname: 'KnightFan',
    });
    assert.equal(goodGuestStart.status, 200);
    assert.equal(goodGuestStart.data.run.isGuest, true);
    assert.equal(goodGuestStart.data.run.username, 'KnightFan');
  });

  it('returns 404 for wrong HTTP method or unknown endpoint', async () => {
    const wrongMethod = await fetch(`${serverURL}/${Endpoint.GetDailyState}`, {
      method: 'POST',
    });
    assert.equal(wrongMethod.status, 404);
    assert.deepEqual((await wrongMethod.json()) as ErrorRsp, {
      error: 'not found',
      status: 404,
    });

    const unknown = await fetch(`${serverURL}/api/does-not-exist`);
    assert.equal(unknown.status, 404);
  });
});
