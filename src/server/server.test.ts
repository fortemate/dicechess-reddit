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
  type GetLeaderboardsRsp,
  type PauseRunRsp,
  type ResignRunRsp,
  type ShareCommentRsp,
  type StartRunRsp,
  type SubmitTurnRsp,
} from '../shared/api.ts';
import { STANDARD_START_FEN, utcDayKey } from '../shared/daily.ts';
import { chooseBotTurn } from '../shared/engine.ts';
import { dbSaveRun } from './db.ts';
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
const originalGet = redis.get.bind(redis);
const originalSet = redis.set.bind(redis);
const originalIncrBy = redis.incrBy.bind(redis);
const originalSubmitComment = reddit.submitComment.bind(reddit);

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
    redis.get = async (key) => redisStore.get(key);
    redis.set = async (key, value) => {
      redisStore.set(key, value);
      return 'OK';
    };
    redis.incrBy = async (key, amount) => {
      const next = Number(redisStore.get(key) ?? '0') + amount;
      redisStore.set(key, `${next}`);
      return next;
    };
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
    reddit.submitComment = originalSubmitComment;
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    redisStore.clear();
    postedComments.length = 0;
    mockNowMs = Date.parse('2026-11-21T12:00:00.000Z');
    mockUser = { userId: 't2_alice', username: 'alice_chess' };
  });

  it('returns daily state with P+2 opening roll, Ashby boss, 3+2 clock, and hunt count', async () => {
    const today = utcDayKey(mockNowMs);
    redisStore.set(`hunt:${today}:count`, '4');

    const rsp = await fetch(`${serverURL}/${Endpoint.GetDailyState}`);
    assert.equal(rsp.status, 200);
    assert.equal(rsp.headers.get('Content-Type'), 'application/json');

    const body = (await rsp.json()) as GetDailyStateRsp;
    assert.equal(body.dayKey, today);
    assert.ok(body.openingRoll.includes('P'));
    assert.equal(body.dailyBoss.id, 'ashby');
    assert.equal(body.initialClockMs, 180_000);
    assert.equal(body.incrementMs, 2_000);
    assert.equal(body.communityHuntCount, 4);
    assert.equal(body.playerUsername, 'alice_chess');
    assert.equal(body.isGuest, false);
  });

  it('awards First Try on attempt 1, prevents duplicate active starts, and drops First Try on attempt 2', async () => {
    const start1 = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    assert.equal(start1.status, 200);
    assert.equal(start1.data.resumed, false);
    assert.equal(start1.data.run.firstTry, true);
    assert.equal(start1.data.run.attemptNumber, 1);
    assert.equal(start1.data.run.status, 'in_game');

    // Opening in a second tab resumes the exact same active run.
    const resume = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    assert.equal(resume.status, 200);
    assert.equal(resume.data.resumed, true);
    assert.equal(resume.data.run.runId, start1.data.run.runId);

    // Resigning finishes attempt 1 and records a Stage 1 epitaph.
    const resign = await postJson<ResignRunRsp>(Endpoint.ResignRun, {
      runId: start1.data.run.runId,
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

  it('validates turns, increments clock by +2s, detects timeout, and blocks pausing mid-game', async () => {
    const start = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    const game = start.data.run.activeGame!;
    assert.equal(game.plyNumber, 1);

    // Pausing during an active game is forbidden.
    const midPause = await postJson<ErrorRsp>(Endpoint.PauseRun, {
      runId: start.data.run.runId,
    });
    assert.equal(midPause.status, 400);

    // Play a valid turn using the engine's legal moves after 5 seconds of thinking.
    mockNowMs += 5_000;
    const legalTurn = chooseBotTurn(
      STANDARD_START_FEN,
      game.currentRoll,
      'greedy',
    );
    const turnRsp = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: start.data.run.runId,
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
      plyNumber: 3,
      moves: [],
    });
    assert.equal(timeoutRsp.status, 200);
    assert.equal(timeoutRsp.data.stageOutcome, 'loss');
    assert.equal(timeoutRsp.data.outcomeReason, 'timeout');
    assert.equal(timeoutRsp.data.run.status, 'finished');
  });

  it('advances stage on win, increments Ashby community hunt on Stage 6, holds stage on draw, and updates leaderboards', async () => {
    const start = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    const run = start.data.run;

    // Seed a Stage 6 position where Black (player) can capture Ashby's White King on e1 immediately.
    const stage6Run = {
      ...run,
      currentStage: 6,
      wins: 5,
      totalTurns: 40,
      activeGame: {
        ...run.activeGame!,
        stage: 6,
        opponent: {
          ...run.activeGame!.opponent,
          stage: 6,
          playerColor: 'b' as const,
        },
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

    const drawStage7 = {
      ...resumed.data.run,
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
      plyNumber: 100,
      moves: ['e1d1'],
    });
    assert.equal(drawRsp.status, 200);
    assert.equal(drawRsp.data.stageOutcome, 'draw');
    assert.equal(drawRsp.data.run.wins, 6);
    assert.equal(drawRsp.data.run.currentStage, 7);
    assert.equal(drawRsp.data.run.status, 'paused_between_games');

    // Verify all 4 leaderboard periods contain Alice's 6-win run.
    const lbs = (await (
      await fetch(`${serverURL}/${Endpoint.GetLeaderboards}`)
    ).json()) as GetLeaderboardsRsp;
    assert.equal(lbs.day[0]?.username, 'alice_chess');
    assert.equal(lbs.day[0]?.wins, 6);
    assert.equal(lbs.week[0]?.wins, 6);
    assert.equal(lbs.month[0]?.wins, 6);
    assert.equal(lbs.year[0]?.wins, 6);

    // Resign and post spoiler-free share card to Reddit comments.
    await postJson<ResignRunRsp>(Endpoint.ResignRun, { runId: run.runId });
    const shareRsp = await postJson<ShareCommentRsp>(Endpoint.ShareComment, {
      runId: run.runId,
    });
    assert.equal(shareRsp.status, 200);
    assert.equal(shareRsp.data.posted, true);
    assert.equal(postedComments.length, 1);
    assert.match(postedComments[0]!.text, /Streak: 6 Wins/);
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
