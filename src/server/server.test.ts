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
import { installRedisMock, type RedisMockController } from './redis-mock.ts';
import { createAppHandler } from './server.ts';

let server: Server;
let serverURL: string;
let mockNowMs = Date.parse('2026-11-21T12:00:00.000Z');
let mockUser: { userId?: string; username?: string } = {
  userId: 't2_alice',
  username: 'alice_chess',
};
const postedComments: Array<{ id: string; text: string }> = [];
let redisMock: RedisMockController;
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
    redisMock = installRedisMock({ yieldOnGet: true });

    reddit.submitComment = ((opts: { id: string; text: string }) => {
      postedComments.push({ id: opts.id, text: opts.text });
      return Promise.resolve({} as never);
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
    redisMock.restore();
    reddit.submitComment = originalSubmitComment;
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    redisMock.clear();
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
    assert.equal(winRsp.data.run.isNewDailyBest, true);
    assert.equal(winRsp.data.run.currentStage, 7);
    assert.equal(winRsp.data.run.status, 'paused_between_games');
    assert.equal(winRsp.data.communityHuntCount, 1);
    assert.equal(winRsp.data.communityHuntTarget, 5);
    assert.equal(winRsp.data.communityHuntBadge, null);

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

  it('tracks asynchronous rival targets and unlocks tiered Community Hunt badges', async () => {
    const today = utcDayKey(mockNowMs);
    await redis.hSet(`hunt:${today}:members`, {
      u1: '1',
      u2: '1',
      u3: '1',
      u4: '1',
      u5: '1',
    });

    // Alice completes a 1-win run and claims Rank #1.
    const aliceStart = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    const aliceWinBoard: StoredRunState = {
      ...aliceStart.data.run,
      playerKey: 'user:t2_alice',
      activeGame: {
        ...aliceStart.data.run.activeGame!,
        baseFen: '4k3/8/8/8/4Q3/8/8/4K3 w - - 0 1',
        plyNumber: 1,
        currentRoll: ['Q', 'P', 'P'] as const,
        turnStartedAtMs: mockNowMs,
      },
    };
    await dbSaveRun(aliceWinBoard);
    const aliceWin = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: aliceStart.data.run.runId,
      gameInstanceId: aliceStart.data.run.activeGame!.gameInstanceId,
      plyNumber: 1,
      moves: ['e4e8'],
    });
    assert.equal(aliceWin.data.communityHuntTarget, 15);
    assert.equal(aliceWin.data.communityHuntBadge, '🥉 Bronze Dragon Slayers');
    assert.equal(aliceWin.data.run.rivalTarget, null);

    // Bob enters the gauntlet and sees Alice as his rival target at Stage 2.
    mockUser = { userId: 't2_bob', username: 'bob_rook' };
    const bobDaily = (await (
      await fetch(`${serverURL}/${Endpoint.GetDailyState}`)
    ).json()) as GetDailyStateRsp;
    assert.equal(bobDaily.communityHuntCount, 5);
    assert.equal(bobDaily.communityHuntTarget, 15);
    assert.equal(bobDaily.communityHuntBadge, '🥉 Bronze Dragon Slayers');
    assert.equal(bobDaily.rivalTarget?.username, 'alice_chess');
    assert.equal(bobDaily.rivalTarget?.wins, 1);
    assert.equal(bobDaily.rivalTarget?.targetStage, 2);

    const bobStart = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    assert.equal(bobStart.data.run.rivalTarget?.username, 'alice_chess');

    // Bob wins Stage 1 and Stage 2 (2 wins > Alice's 1 win) -> overtakes Alice!
    const bobStage2WinBoard: StoredRunState = {
      ...bobStart.data.run,
      playerKey: 'user:t2_bob',
      wins: 1,
      totalTurns: 1,
      currentStage: 2,
      activeGame: {
        ...bobStart.data.run.activeGame!,
        stage: 2,
        opponent: getStageOpponent(2),
        baseFen: '4k3/8/8/8/4q3/8/8/4K3 b - - 0 1',
        plyNumber: 2,
        currentRoll: ['Q', 'P', 'P'] as const,
        turnStartedAtMs: mockNowMs,
      },
    };
    await dbSaveRun(bobStage2WinBoard);
    const bobWin = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      runId: bobStart.data.run.runId,
      gameInstanceId: bobStart.data.run.activeGame!.gameInstanceId,
      plyNumber: 2,
      moves: ['e4e1'],
    });
    assert.equal(bobWin.data.run.wins, 2);
    assert.equal(bobWin.data.run.isNewDailyBest, true);
    assert.equal(bobWin.data.run.rivalTarget, null);

    // Advancing to Stage 3 clears the stage win banner, while losing/resigning Stage 3 still preserves personal best on finish.
    const bobStage3 = await postJson<StartRunRsp>(Endpoint.StartRun, {});
    assert.equal(bobStage3.data.resumed, true);
    assert.equal(bobStage3.data.run.currentStage, 3);
    assert.equal(bobStage3.data.run.isNewDailyBest, undefined);

    const bobResign = await postJson<ResignRunRsp>(Endpoint.ResignRun, {
      runId: bobStart.data.run.runId,
    });
    assert.equal(bobResign.data.run.status, 'finished');
    assert.equal(bobResign.data.run.isNewDailyBest, true);
    assert.equal(
      'achievedDailyBest' in
        (bobResign.data.run as unknown as Record<string, unknown>),
      false,
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
