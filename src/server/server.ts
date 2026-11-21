import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { context, reddit } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import {
  Endpoint,
  EndpointMethod,
  type ActiveGameSnapshot,
  type ErrorRsp,
  type GetDailyStateRsp,
  type GetLeaderboardsRsp,
  type PauseRunReq,
  type PauseRunRsp,
  type ResignRunReq,
  type ResignRunRsp,
  type RunState,
  type ShareCommentReq,
  type ShareCommentRsp,
  type StageChronicleEntry,
  type StartRunReq,
  type StartRunRsp,
  type SubmitTurnReq,
  type SubmitTurnRsp,
} from '../shared/api.ts';
import {
  GAUNTLET_LADDER,
  getDailyOpeningRoll,
  getDailyThemeName,
  getStageOpponent,
  INCREMENT_MS,
  INITIAL_CLOCK_MS,
  STANDARD_START_FEN,
  utcDayKey,
} from '../shared/daily.ts';
import {
  formatSpoilerFreeShareCard,
  pickCharacterLine,
  type DialogueEvent,
} from '../shared/dialogue.ts';
import {
  chooseBotTurn,
  completeTurnAndAdvance,
  hasImmediateKingThreat,
  rollForTurn,
  type CompletedTurnOutcome,
  type GameTerminalResult,
} from '../shared/engine.ts';
import {
  dbClaimAttempt,
  dbGetActiveRun,
  dbGetAttemptCount,
  dbGetCommunityHuntCount,
  dbGetDailyRank,
  dbGetLeaderboards,
  dbGetRunById,
  dbGetStageEpitaph,
  dbGetStageEpitaphs,
  dbRecordCommunityHuntWin,
  dbRecordLeaderboardRun,
  dbRecordStageAttempt,
  dbRecordStageDeath,
  dbSaveRun,
  DEFAULT_HUNT_TARGET,
  resolvePlayerIdentity,
  type PlayerIdentity,
} from './db.ts';

export interface ServerDeps {
  readonly now: () => number;
  readonly random: () => number;
}

const DEFAULT_DEPS: ServerDeps = {
  now: () => Date.now(),
  random: () => Math.random(),
};

type AnyRsp =
  | GetDailyStateRsp
  | GetLeaderboardsRsp
  | StartRunRsp
  | SubmitTurnRsp
  | PauseRunRsp
  | ResignRunRsp
  | ShareCommentRsp
  | UiResponse
  | TriggerResponse
  | ErrorRsp;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createAppHandler(overrides?: Partial<ServerDeps>) {
  const deps: ServerDeps = {
    now: overrides?.now ?? DEFAULT_DEPS.now,
    random: overrides?.random ?? DEFAULT_DEPS.random,
  };

  return async function handleReq(
    reqMsg: IncomingMessage,
    rspMsg: ServerResponse,
  ): Promise<void> {
    try {
      await route(reqMsg, rspMsg, deps);
    } catch (err) {
      if (err instanceof HttpError) {
        writeJson(
          err.status,
          { error: err.message, status: err.status } satisfies ErrorRsp,
          rspMsg,
        );
        return;
      }
      const msg = `server error; ${err instanceof Error ? err.stack : err}`;
      console.error(msg);
      writeJson(500, { error: msg, status: 500 } satisfies ErrorRsp, rspMsg);
    }
  };
}

export const onReq = createAppHandler();

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const parsedUrl = new URL(reqMsg.url ?? '/', 'http://localhost');
  const endpointPath = parsedUrl.pathname.slice(1);
  const endpoint = endpointPath as Endpoint;
  const method = (EndpointMethod as Record<string, 'GET' | 'POST'>)[endpoint];

  let rsp: AnyRsp;
  if (!method || method !== reqMsg.method) {
    rsp = { error: 'not found', status: 404 };
  } else {
    switch (endpoint) {
      case Endpoint.GetDailyState:
        rsp = await routeGetDailyState(parsedUrl, deps);
        break;
      case Endpoint.GetLeaderboards:
        rsp = await dbGetLeaderboards(deps.now());
        break;
      case Endpoint.StartRun:
        rsp = await routeStartRun(await readJson<StartRunReq>(reqMsg), deps);
        break;
      case Endpoint.SubmitTurn:
        rsp = await routeSubmitTurn(
          await readJson<SubmitTurnReq>(reqMsg),
          deps,
        );
        break;
      case Endpoint.PauseRun:
        rsp = await routePauseRun(await readJson<PauseRunReq>(reqMsg), deps);
        break;
      case Endpoint.ResignRun:
        rsp = await routeResignRun(await readJson<ResignRunReq>(reqMsg), deps);
        break;
      case Endpoint.ShareComment:
        rsp = await routeShareComment(await readJson<ShareCommentReq>(reqMsg));
        break;
      case Endpoint.OnMenuNewPost:
        await drainRequestBody(reqMsg);
        rsp = await routeMenuNewPost(deps);
        break;
      case Endpoint.OnAppInstall:
        await drainRequestBody(reqMsg);
        rsp = await routeAppInstall(deps);
        break;
      default:
        endpoint satisfies never;
        rsp = { error: 'not found', status: 404 };
        break;
    }
  }

  const status = 'status' in rsp ? rsp.status : 200;
  writeJson(status, rsp, rspMsg);
}

async function routeGetDailyState(
  url: URL,
  deps: ServerDeps,
): Promise<GetDailyStateRsp> {
  const nowMs = deps.now();
  const dayKey = utcDayKey(nowMs);
  const openingRoll = getDailyOpeningRoll(dayKey);
  const dailyBoss = GAUNTLET_LADDER[GAUNTLET_LADDER.length - 1]!;
  const guestId = url.searchParams.get('guestId') ?? undefined;
  const identity = currentIdentity(guestId);

  const [
    communityHuntCount,
    leaderboards,
    stageEpitaphs,
    attemptsToday,
    existingRun,
  ] = await Promise.all([
    dbGetCommunityHuntCount(dayKey),
    dbGetLeaderboards(nowMs),
    dbGetStageEpitaphs(dayKey),
    dbGetAttemptCount(dayKey, identity.playerKey),
    dbGetActiveRun(dayKey, identity.playerKey),
  ]);

  const syncedRun = existingRun
    ? await syncClockExpiration(existingRun, deps)
    : null;

  return {
    dayKey,
    themeName: getDailyThemeName(openingRoll),
    openingRoll,
    dailyBoss,
    initialClockMs: INITIAL_CLOCK_MS,
    incrementMs: INCREMENT_MS,
    communityHuntCount,
    communityHuntTarget: DEFAULT_HUNT_TARGET,
    topLeaders: leaderboards.day.slice(0, 3),
    stageEpitaphs,
    playerUsername: identity.username,
    isGuest: identity.isGuest,
    attemptsToday,
    activeRun: syncedRun,
  };
}

async function routeStartRun(
  req: StartRunReq,
  deps: ServerDeps,
): Promise<StartRunRsp> {
  const nowMs = deps.now();
  const dayKey = utcDayKey(nowMs);
  const identity = currentIdentity(req.guestId, req.guestNickname);

  const existing = await dbGetActiveRun(dayKey, identity.playerKey);
  if (existing && !req.forceNew) {
    const synced = await syncClockExpiration(existing, deps);
    if (synced.status === 'in_game') {
      return { run: synced, resumed: true };
    }
    if (synced.status === 'paused_between_games') {
      const launched = await launchStageIntoRun(synced, deps);
      await dbSaveRun(launched);
      return { run: launched, resumed: true };
    }
  }

  if (existing && req.forceNew && existing.status === 'in_game') {
    await finalizeLossRun(
      existing,
      existing.activeGame?.playerTurnCount ?? 0,
      'resigned',
      deps,
    );
  }

  const openingRoll = getDailyOpeningRoll(dayKey);
  const { attemptNumber, firstTry } = await dbClaimAttempt(
    dayKey,
    identity.playerKey,
  );
  const freshRun: RunState = {
    runId: randomUUID(),
    dayKey,
    playerKey: identity.playerKey,
    username: identity.username,
    isGuest: identity.isGuest,
    attemptNumber,
    firstTry,
    openingRoll,
    status: 'paused_between_games',
    currentStage: 1,
    wins: 0,
    totalTurns: 0,
    chronicle: [],
    activeGame: null,
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  const startedRun = await launchStageIntoRun(freshRun, deps);
  await dbSaveRun(startedRun);
  return { run: startedRun, resumed: false };
}

async function launchStageIntoRun(
  run: RunState,
  deps: ServerDeps,
): Promise<RunState> {
  const nowMs = deps.now();
  const opponent = getStageOpponent(run.currentStage);
  await dbRecordStageAttempt(run.dayKey, run.currentStage, opponent.boss.id);

  let baseFen = STANDARD_START_FEN;
  let plyNumber = 1;
  let lastBotMoves: string[] = [];
  let botLine = pickCharacterLine(
    opponent.boss.id,
    'intro',
    undefined,
    deps.random,
  ).text;

  // On even stages the bot opens first as White using the Daily Opening Roll.
  if (opponent.playerColor === 'b') {
    const botRoll = rollForTurn(1, run.openingRoll, deps.random);
    const botMoves = chooseBotTurn(
      baseFen,
      botRoll,
      opponent.boss.engineAlgorithm,
    );
    const botOutcome = completeTurnAndAdvance(baseFen, botRoll, botMoves, 1);
    baseFen = botOutcome.nextFen;
    plyNumber = 2;
    lastBotMoves = botMoves;
    const event = pickDialogueForBotOutcome(
      botOutcome,
      opponent.playerColor,
      false,
    );
    if (event) {
      botLine = pickCharacterLine(
        opponent.boss.id,
        event,
        undefined,
        deps.random,
      ).text;
    }
  }

  const currentRoll = rollForTurn(plyNumber, run.openingRoll, deps.random);
  const activeGame: ActiveGameSnapshot = {
    stage: run.currentStage,
    opponent,
    baseFen,
    plyNumber,
    playerTurnCount: 0,
    currentRoll,
    playerRemainingMs: INITIAL_CLOCK_MS,
    botRemainingMs: INITIAL_CLOCK_MS,
    turnStartedAtMs: nowMs,
    lastBotMoves,
    botLine,
  };

  const { nextStageEpitaph: _dropped, ...rest } = run;
  return {
    ...rest,
    status: 'in_game',
    activeGame,
    updatedAtMs: nowMs,
  };
}

async function routeSubmitTurn(
  req: SubmitTurnReq,
  deps: ServerDeps,
): Promise<SubmitTurnRsp> {
  if (!req.runId || !Array.isArray(req.moves)) {
    throw new HttpError(400, 'Missing runId or moves');
  }
  const identity = currentIdentity(req.guestId);
  const run = await requireAuthorizedRun(req.runId, identity);

  if (run.status !== 'in_game' || !run.activeGame) {
    throw new HttpError(409, 'Run does not have an active game in progress');
  }
  const activeGame = run.activeGame;
  if (req.plyNumber !== activeGame.plyNumber) {
    throw new HttpError(
      409,
      `Stale ply ${req.plyNumber}; expected ${activeGame.plyNumber}`,
    );
  }

  const nowMs = deps.now();
  const elapsedMs = Math.max(0, nowMs - activeGame.turnStartedAtMs);
  const remainingAfterThink = activeGame.playerRemainingMs - elapsedMs;
  if (remainingAfterThink <= 0) {
    const expiredRun = await finalizeLossRun(
      run,
      activeGame.playerTurnCount,
      'timeout',
      deps,
    );
    const huntCount = await dbGetCommunityHuntCount(run.dayKey);
    return {
      run: expiredRun,
      lastPlayerMoves: [],
      lastBotMoves: [],
      stageOutcome: 'loss',
      outcomeReason: 'timeout',
      communityHuntCount: huntCount,
      communityHuntTarget: DEFAULT_HUNT_TARGET,
    };
  }

  let playerOutcome: CompletedTurnOutcome;
  try {
    playerOutcome = completeTurnAndAdvance(
      activeGame.baseFen,
      activeGame.currentRoll,
      req.moves,
      activeGame.plyNumber,
    );
  } catch (err) {
    throw new HttpError(
      400,
      err instanceof Error ? err.message : 'Illegal turn sequence',
    );
  }

  const nextPlayerRemainingMs = remainingAfterThink + INCREMENT_MS;
  const nextPlayerTurnCount = activeGame.playerTurnCount + 1;
  const { boss, playerColor } = activeGame.opponent;

  if (playerOutcome.terminalResult) {
    const outcome = await handleStageTerminal(
      run,
      activeGame,
      playerOutcome.terminalResult,
      nextPlayerTurnCount,
      req.moves,
      [],
      deps,
    );
    return outcome;
  }

  const botPly = activeGame.plyNumber + 1;
  const botRoll = rollForTurn(botPly, run.openingRoll, deps.random);
  const botMoves = chooseBotTurn(
    playerOutcome.nextFen,
    botRoll,
    boss.engineAlgorithm,
  );
  const botOutcome = completeTurnAndAdvance(
    playerOutcome.nextFen,
    botRoll,
    botMoves,
    botPly,
  );

  if (botOutcome.terminalResult) {
    return handleStageTerminal(
      run,
      activeGame,
      botOutcome.terminalResult,
      nextPlayerTurnCount,
      req.moves,
      botMoves,
      deps,
    );
  }

  const playerInDanger = hasImmediateKingThreat(
    botOutcome.nextFen,
    playerColor,
  );
  const dialogueEvent = pickDialogueForBotOutcome(
    botOutcome,
    playerColor,
    playerInDanger,
  );
  const botLine = dialogueEvent
    ? pickCharacterLine(boss.id, dialogueEvent, undefined, deps.random).text
    : activeGame.botLine;

  const nextPlayerPly = botPly + 1;
  const nextPlayerRoll = rollForTurn(
    nextPlayerPly,
    run.openingRoll,
    deps.random,
  );
  const updatedGame: ActiveGameSnapshot = {
    stage: activeGame.stage,
    opponent: activeGame.opponent,
    baseFen: botOutcome.nextFen,
    plyNumber: nextPlayerPly,
    playerTurnCount: nextPlayerTurnCount,
    currentRoll: nextPlayerRoll,
    playerRemainingMs: nextPlayerRemainingMs,
    botRemainingMs: activeGame.botRemainingMs,
    turnStartedAtMs: nowMs,
    lastBotMoves: botMoves,
    ...(botLine ? { botLine } : {}),
  };

  const updatedRun: RunState = {
    ...run,
    activeGame: updatedGame,
    updatedAtMs: nowMs,
  };
  await dbSaveRun(updatedRun);

  const communityHuntCount = await dbGetCommunityHuntCount(run.dayKey);
  return {
    run: updatedRun,
    lastPlayerMoves: req.moves,
    lastBotMoves: botMoves,
    ...(botLine ? { botLine } : {}),
    communityHuntCount,
    communityHuntTarget: DEFAULT_HUNT_TARGET,
  };
}

async function handleStageTerminal(
  run: RunState,
  activeGame: ActiveGameSnapshot,
  terminalResult: GameTerminalResult,
  playerTurnCount: number,
  lastPlayerMoves: readonly string[],
  lastBotMoves: readonly string[],
  deps: ServerDeps,
): Promise<SubmitTurnRsp> {
  const nowMs = deps.now();
  const { boss, playerColor } = activeGame.opponent;

  if (terminalResult.winner === playerColor) {
    const entry: StageChronicleEntry = {
      stage: activeGame.stage,
      bossId: boss.id,
      bossName: boss.name,
      outcome: 'win',
      turns: playerTurnCount,
      reason: terminalResult.reason,
    };
    const nextStage = activeGame.stage + 1;
    const nextWins = run.wins + 1;
    const nextTotalTurns = run.totalTurns + playerTurnCount;

    let communityHuntCount = await dbGetCommunityHuntCount(run.dayKey);
    if (activeGame.stage === 6) {
      const hunt = await dbRecordCommunityHuntWin(
        run.dayKey,
        run.playerKey,
        run.isGuest,
      );
      communityHuntCount = hunt.count;
    }

    const nextStageEpitaph = await dbGetStageEpitaph(run.dayKey, nextStage);
    const botLine = pickCharacterLine(
      boss.id,
      'loss',
      undefined,
      deps.random,
    ).text;

    const progressedRun: RunState = {
      ...run,
      status: 'paused_between_games',
      currentStage: nextStage,
      wins: nextWins,
      totalTurns: nextTotalTurns,
      chronicle: [...run.chronicle, entry],
      activeGame: null,
      nextStageEpitaph,
      updatedAtMs: nowMs,
    };
    const { dailyRank } = await dbRecordLeaderboardRun(progressedRun, nowMs);
    const savedRun: RunState =
      dailyRank !== null ? { ...progressedRun, dailyRank } : progressedRun;
    await dbSaveRun(savedRun);

    return {
      run: savedRun,
      lastPlayerMoves,
      lastBotMoves,
      botLine,
      stageOutcome: 'win',
      outcomeReason: terminalResult.reason,
      communityHuntCount,
      communityHuntTarget: DEFAULT_HUNT_TARGET,
    };
  }

  if (terminalResult.winner === null) {
    const entry: StageChronicleEntry = {
      stage: activeGame.stage,
      bossId: boss.id,
      bossName: boss.name,
      outcome: 'draw',
      turns: playerTurnCount,
      reason: terminalResult.reason,
    };
    const nextStageEpitaph = await dbGetStageEpitaph(
      run.dayKey,
      activeGame.stage,
    );
    const botLine = pickCharacterLine(
      boss.id,
      'draw',
      undefined,
      deps.random,
    ).text;
    const drawnRun: RunState = {
      ...run,
      status: 'paused_between_games',
      chronicle: [...run.chronicle, entry],
      activeGame: null,
      nextStageEpitaph,
      updatedAtMs: nowMs,
    };
    await dbSaveRun(drawnRun);

    return {
      run: drawnRun,
      lastPlayerMoves,
      lastBotMoves,
      botLine,
      stageOutcome: 'draw',
      outcomeReason: terminalResult.reason,
      communityHuntCount: await dbGetCommunityHuntCount(run.dayKey),
      communityHuntTarget: DEFAULT_HUNT_TARGET,
    };
  }

  const botLine = pickCharacterLine(
    boss.id,
    'win',
    undefined,
    deps.random,
  ).text;
  const finishedRun = await finalizeLossRun(
    run,
    playerTurnCount,
    terminalResult.reason,
    deps,
  );
  return {
    run: finishedRun,
    lastPlayerMoves,
    lastBotMoves,
    botLine,
    stageOutcome: 'loss',
    outcomeReason: terminalResult.reason,
    communityHuntCount: await dbGetCommunityHuntCount(run.dayKey),
    communityHuntTarget: DEFAULT_HUNT_TARGET,
  };
}

async function finalizeLossRun(
  run: RunState,
  playerTurnCount: number,
  reason: GameTerminalResult['reason'],
  deps: ServerDeps,
): Promise<RunState> {
  const nowMs = deps.now();
  const stage = run.activeGame?.stage ?? run.currentStage;
  const opponent = run.activeGame?.opponent ?? getStageOpponent(stage);

  await dbRecordStageDeath(
    run.dayKey,
    stage,
    opponent.boss.id,
    run.username,
    playerTurnCount,
  );

  const entry: StageChronicleEntry = {
    stage,
    bossId: opponent.boss.id,
    bossName: opponent.boss.name,
    outcome: 'loss',
    turns: playerTurnCount,
    reason,
  };
  const updatedChronicle = [...run.chronicle, entry];
  const candidateRun: RunState = {
    ...run,
    status: 'finished',
    chronicle: updatedChronicle,
    activeGame: null,
    updatedAtMs: nowMs,
    completedAtMs: nowMs,
  };

  const { dailyRank } = await dbRecordLeaderboardRun(candidateRun, nowMs);
  const effectiveRank =
    dailyRank ?? (await dbGetDailyRank(run.dayKey, run.playerKey));
  const shareCardText = formatSpoilerFreeShareCard({
    dayKey: run.dayKey,
    openingRoll: run.openingRoll,
    firstTry: run.firstTry,
    wins: run.wins,
    totalTurns: run.totalTurns,
    rank: effectiveRank,
    stages: updatedChronicle.map((item) => ({
      stage: item.stage,
      bossName: item.bossName,
      outcome: item.outcome,
      turns: item.turns,
    })),
  });

  const finishedRun: RunState = {
    ...candidateRun,
    ...(effectiveRank !== null ? { dailyRank: effectiveRank } : {}),
    shareCardText,
  };
  await dbSaveRun(finishedRun);
  return finishedRun;
}

async function syncClockExpiration(
  run: RunState,
  deps: ServerDeps,
): Promise<RunState> {
  if (run.status !== 'in_game' || !run.activeGame) {
    return run;
  }
  const elapsedMs = Math.max(0, deps.now() - run.activeGame.turnStartedAtMs);
  if (run.activeGame.playerRemainingMs - elapsedMs > 0) {
    return run;
  }
  return finalizeLossRun(run, run.activeGame.playerTurnCount, 'timeout', deps);
}

async function routePauseRun(
  req: PauseRunReq,
  deps: ServerDeps,
): Promise<PauseRunRsp> {
  if (!req.runId) {
    throw new HttpError(400, 'Missing runId');
  }
  const identity = currentIdentity(req.guestId);
  const run = await requireAuthorizedRun(req.runId, identity);
  if (run.status === 'in_game') {
    throw new HttpError(
      400,
      'Pause is only allowed between games, never during an active clock',
    );
  }
  const updated: RunState = {
    ...run,
    updatedAtMs: deps.now(),
  };
  await dbSaveRun(updated);
  return { run: updated };
}

async function routeResignRun(
  req: ResignRunReq,
  deps: ServerDeps,
): Promise<ResignRunRsp> {
  if (!req.runId) {
    throw new HttpError(400, 'Missing runId');
  }
  const identity = currentIdentity(req.guestId);
  const run = await requireAuthorizedRun(req.runId, identity);
  if (run.status === 'finished') {
    return { run };
  }
  const finished = await finalizeLossRun(
    run,
    run.activeGame?.playerTurnCount ?? 0,
    'resigned',
    deps,
  );
  return { run: finished };
}

async function routeShareComment(
  req: ShareCommentReq,
): Promise<ShareCommentRsp> {
  if (!req.runId) {
    throw new HttpError(400, 'Missing runId');
  }
  const identity = currentIdentity(req.guestId);
  const run = await requireAuthorizedRun(req.runId, identity);
  const shareText =
    run.shareCardText ??
    formatSpoilerFreeShareCard({
      dayKey: run.dayKey,
      openingRoll: run.openingRoll,
      firstTry: run.firstTry,
      wins: run.wins,
      totalTurns: run.totalTurns,
      rank: run.dailyRank ?? null,
      stages: run.chronicle.map((item) => ({
        stage: item.stage,
        bossName: item.bossName,
        outcome: item.outcome,
        turns: item.turns,
      })),
    });

  if (run.isGuest || !context.postId) {
    return {
      posted: false,
      shareText,
      reason: run.isGuest
        ? 'Sign in to Reddit to post directly; your spoiler-free card is ready to copy.'
        : 'Reddit post context unavailable.',
    };
  }

  try {
    await reddit.submitComment({
      id: context.postId,
      text: shareText,
      runAs: 'USER',
    });
    return { posted: true, shareText };
  } catch (err) {
    return {
      posted: false,
      shareText,
      reason:
        err instanceof Error
          ? err.message
          : 'Could not submit comment directly; copy and paste below.',
    };
  }
}

function pickDialogueForBotOutcome(
  outcome: CompletedTurnOutcome,
  playerColor: 'w' | 'b',
  playerInDanger: boolean,
): DialogueEvent | null {
  if (outcome.terminalResult) {
    if (outcome.terminalResult.winner === null) return 'draw';
    return outcome.terminalResult.winner === playerColor ? 'loss' : 'win';
  }
  const hasHeavyCapture = outcome.capturedPieces.some((p) => {
    const lower = p.toLowerCase();
    return lower === 'q' || lower === 'r';
  });
  if (hasHeavyCapture) return 'capture_heavy';
  if (playerInDanger) return 'threat';
  if (outcome.wasForcedPass) return 'empty_roll';
  if (outcome.capturedPieces.length > 0) return 'capture';
  return null;
}

function currentIdentity(
  guestId?: string,
  guestNickname?: string,
): PlayerIdentity {
  const ctx = context as unknown as {
    userId?: string;
    username?: string;
  };
  return resolvePlayerIdentity(
    ctx.userId,
    ctx.username,
    guestId,
    guestNickname,
  );
}

async function requireAuthorizedRun(
  runId: string,
  identity: PlayerIdentity,
): Promise<RunState> {
  const run = await dbGetRunById(runId);
  if (!run) {
    throw new HttpError(404, 'Run not found');
  }
  if (run.playerKey !== identity.playerKey) {
    throw new HttpError(403, 'Run belongs to another player');
  }
  return run;
}

async function routeMenuNewPost(deps: ServerDeps): Promise<UiResponse> {
  const dayKey = utcDayKey(deps.now());
  const post = await reddit.submitCustomPost({
    title: `Dice Chess Daily — ${dayKey}`,
  });
  return {
    showToast: { text: `Post ${post.id} created.`, appearance: 'success' },
    navigateTo: post.url,
  };
}

async function routeAppInstall(deps: ServerDeps): Promise<TriggerResponse> {
  const dayKey = utcDayKey(deps.now());
  await reddit.submitCustomPost({
    title: `Dice Chess Daily — ${dayKey}`,
  });
  return {};
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  reqMsg.on('data', (chunk: Uint8Array) => chunks.push(chunk));
  await once(reqMsg, 'end');
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON payload');
  }
}

async function drainRequestBody(reqMsg: IncomingMessage): Promise<void> {
  if (reqMsg.readableEnded) return;
  reqMsg.resume();
  await once(reqMsg, 'end');
}

function writeJson(status: number, json: unknown, rsp: ServerResponse): void {
  const body = JSON.stringify(json);
  const len = Buffer.byteLength(body);
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  });
  rsp.end(body);
}
