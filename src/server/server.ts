import { randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { context, reddit } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import {
  Endpoint,
  EndpointMethod,
  type ActiveGameSnapshot,
  type ErrorRsp,
  type GetDailyStateRsp,
  type LeaderboardsBundle,
  type PauseRunReq,
  type PauseRunRsp,
  type ResignRunReq,
  type ResignRunRsp,
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
  getCommunityHuntStatus,
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
  dbClaimOrCreateRun,
  dbGetActiveRun,
  dbGetAttemptCount,
  dbGetCommunityHuntCount,
  dbGetCurrentRunId,
  dbGetLeaderboards,
  dbGetNextRival,
  dbGetRunById,
  dbGetStageEpitaph,
  dbGetStageEpitaphs,
  dbRecordCommunityHuntWin,
  dbRecordLeaderboardRun,
  dbRecordStageAttempt,
  dbRecordStageDeath,
  dbSaveRunCas,
  resolvePlayerIdentity,
  toPublicRunState,
  type PlayerIdentity,
  type StoredRunState,
} from './db.ts';

const MAX_BODY_BYTES = 64 * 1024;

export interface ServerDeps {
  readonly now: () => number;
  readonly random: () => number;
}

const DEFAULT_DEPS: ServerDeps = {
  now: () => Date.now(),
  random: () => randomInt(0, 0x100000000) / 0x100000000,
};

type AnyRsp =
  | GetDailyStateRsp
  | LeaderboardsBundle
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
      console.error('Unhandled server error:', err);
      writeJson(
        500,
        { error: 'internal server error', status: 500 } satisfies ErrorRsp,
        rspMsg,
      );
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
    rsp = await dispatchEndpoint(endpoint, parsedUrl, reqMsg, deps);
  }

  const status = 'status' in rsp ? rsp.status : 200;
  writeJson(status, rsp, rspMsg);
}

async function dispatchEndpoint(
  endpoint: Endpoint,
  parsedUrl: URL,
  reqMsg: IncomingMessage,
  deps: ServerDeps,
): Promise<AnyRsp> {
  switch (endpoint) {
    case Endpoint.GetDailyState:
      return routeGetDailyState(parsedUrl, deps);
    case Endpoint.GetLeaderboards:
      return routeGetLeaderboards(parsedUrl, deps);
    case Endpoint.StartRun:
      return routeStartRun(await readJson<StartRunReq>(reqMsg), deps);
    case Endpoint.SubmitTurn:
      return routeSubmitTurn(await readJson<SubmitTurnReq>(reqMsg), deps);
    case Endpoint.PauseRun:
      return routePauseRun(await readJson<PauseRunReq>(reqMsg), deps);
    case Endpoint.ResignRun:
      return routeResignRun(await readJson<ResignRunReq>(reqMsg), deps);
    case Endpoint.ShareComment:
      return routeShareComment(await readJson<ShareCommentReq>(reqMsg));
    case Endpoint.OnMenuNewPost:
      await drainRequestBody(reqMsg);
      return routeMenuNewPost(deps);
    case Endpoint.OnAppInstall:
      await drainRequestBody(reqMsg);
      return routeAppInstall(deps);
    default:
      endpoint satisfies never;
      return { error: 'not found', status: 404 };
  }
}

async function routeGetLeaderboards(
  url: URL,
  deps: ServerDeps,
): Promise<LeaderboardsBundle> {
  const guestId = url.searchParams.get('guestId') ?? undefined;
  const identity = currentIdentity(guestId);
  return dbGetLeaderboards(deps.now(), identity.playerKey);
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

  const existingRun = await dbGetActiveRun(dayKey, identity.playerKey);
  const syncedRun = existingRun
    ? await syncClockExpiration(existingRun, deps)
    : null;

  const progressForRival =
    syncedRun && syncedRun.status !== 'finished'
      ? {
          wins: syncedRun.wins,
          totalTurns: syncedRun.totalTurns,
          firstTry: syncedRun.firstTry,
        }
      : undefined;

  const [
    communityHuntCount,
    leaderboards,
    stageEpitaphs,
    attemptsToday,
    rivalTarget,
  ] = await Promise.all([
    dbGetCommunityHuntCount(dayKey),
    dbGetLeaderboards(nowMs, identity.playerKey),
    dbGetStageEpitaphs(dayKey),
    dbGetAttemptCount(dayKey, identity.playerKey),
    dbGetNextRival(dayKey, identity.playerKey, progressForRival),
  ]);
  const hunt = getCommunityHuntStatus(communityHuntCount);

  return {
    serverNowMs: deps.now(),
    dayKey,
    themeName: getDailyThemeName(openingRoll),
    openingRoll,
    dailyBoss,
    initialClockMs: INITIAL_CLOCK_MS,
    incrementMs: INCREMENT_MS,
    communityHuntCount: hunt.count,
    communityHuntTarget: hunt.target,
    communityHuntBadge: hunt.badgeLabel,
    rivalTarget,
    topLeaders: leaderboards.day.slice(0, 3),
    stageEpitaphs,
    playerUsername: identity.username,
    isGuest: identity.isGuest,
    attemptsToday,
    activeRun: syncedRun
      ? await toPublicRunWithRival(syncedRun, rivalTarget)
      : null,
  };
}

async function routeStartRun(
  req: StartRunReq,
  deps: ServerDeps,
): Promise<StartRunRsp> {
  if (req.forceNew !== undefined && typeof req.forceNew !== 'boolean') {
    throw new HttpError(400, 'forceNew must be a boolean');
  }
  const identity = currentIdentity(req.guestId, req.guestNickname);
  assertValidMutatingIdentity(identity);

  const nowMs = deps.now();
  const dayKey = utcDayKey(nowMs);
  const openingRoll = getDailyOpeningRoll(dayKey);

  const claim = await dbClaimOrCreateRun({
    dayKey,
    playerKey: identity.playerKey,
    forceNew: Boolean(req.forceNew),
    onRetireExistingRun: async (existingRun) => {
      if (existingRun.status === 'in_game') {
        await finalizeLossRun(
          existingRun,
          existingRun.activeGame?.playerTurnCount ?? 0,
          'resigned',
          deps,
        );
      } else if (existingRun.status === 'paused_between_games') {
        await retirePausedRunWithoutDeath(existingRun, deps);
      }
    },
    buildNewRun: (attemptNumber, firstTry) => {
      const freshRun: StoredRunState = {
        runId: randomUUID(),
        revision: 0,
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
      return prepareStageLaunch(freshRun, deps, 1);
    },
  });

  if (claim.kind === 'created') {
    await dbRecordStageAttempt(claim.run.dayKey, claim.run.currentStage);
    return {
      serverNowMs: deps.now(),
      run: await toPublicRunWithRival(claim.run),
      resumed: false,
    };
  }

  const synced = await syncClockExpiration(claim.run, deps);
  if (synced.status !== 'paused_between_games') {
    return {
      serverNowMs: deps.now(),
      run: await toPublicRunWithRival(synced),
      resumed: true,
    };
  }

  const launched = prepareStageLaunch(synced, deps, synced.revision + 1);
  const cas = await dbSaveRunCas(launched, synced.revision);
  if (!cas.committed || !cas.run) {
    if (cas.run) {
      return {
        serverNowMs: deps.now(),
        run: await toPublicRunWithRival(cas.run),
        resumed: true,
      };
    }
    throw new HttpError(409, 'Run state changed concurrently; please retry');
  }
  await dbRecordStageAttempt(cas.run.dayKey, cas.run.currentStage);
  return {
    serverNowMs: deps.now(),
    run: await toPublicRunWithRival(cas.run),
    resumed: true,
  };
}

function prepareStageLaunch(
  run: StoredRunState,
  deps: ServerDeps,
  targetRevision: number,
): StoredRunState {
  const opponent = getStageOpponent(run.currentStage);
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
  // Sample clock timestamp AFTER bot computation so bot thinking is never billed to the player.
  const turnStartedAtMs = deps.now();
  const activeGame: ActiveGameSnapshot = {
    gameInstanceId: `${run.runId}:s${run.currentStage}:g${targetRevision}`,
    stage: run.currentStage,
    opponent,
    baseFen,
    plyNumber,
    playerTurnCount: 0,
    currentRoll,
    playerRemainingMs: INITIAL_CLOCK_MS,
    botRemainingMs: INITIAL_CLOCK_MS,
    turnStartedAtMs,
    lastBotMoves,
    botLine,
  };

  const { nextStageEpitaph: _dropped, isNewDailyBest: _oldBest, ...rest } = run;
  return {
    ...rest,
    status: 'in_game',
    activeGame,
    updatedAtMs: turnStartedAtMs,
  };
}

async function routeSubmitTurn(
  req: SubmitTurnReq,
  deps: ServerDeps,
): Promise<SubmitTurnRsp> {
  if (
    !req.runId ||
    typeof req.gameInstanceId !== 'string' ||
    !Array.isArray(req.moves)
  ) {
    throw new HttpError(400, 'Missing runId, gameInstanceId, or moves');
  }
  const identity = currentIdentity(req.guestId);
  assertValidMutatingIdentity(identity);

  const run = await requireAuthorizedRun(req.runId, identity);
  if (run.status !== 'in_game' || !run.activeGame) {
    throw new HttpError(409, 'Run does not have an active game in progress');
  }
  const activeGame = run.activeGame;
  if (req.gameInstanceId !== activeGame.gameInstanceId) {
    throw new HttpError(
      409,
      'game instance is out of date; reload current run state',
    );
  }
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
    const hunt = getCommunityHuntStatus(
      await dbGetCommunityHuntCount(run.dayKey),
    );
    return {
      serverNowMs: deps.now(),
      run: toPublicRunState(expiredRun),
      lastPlayerMoves: [],
      lastBotMoves: [],
      stageOutcome: 'loss',
      outcomeReason: 'timeout',
      communityHuntCount: hunt.count,
      communityHuntTarget: hunt.target,
      communityHuntBadge: hunt.badgeLabel,
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
    return handleStageTerminal(
      run,
      activeGame,
      playerOutcome.terminalResult,
      nextPlayerTurnCount,
      req.moves,
      [],
      deps,
    );
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
  // Sample clock start AFTER bot calculation so bot compute never subtracts player time.
  const turnStartedAtMs = deps.now();
  const updatedGame: ActiveGameSnapshot = {
    gameInstanceId: activeGame.gameInstanceId,
    stage: activeGame.stage,
    opponent: activeGame.opponent,
    baseFen: botOutcome.nextFen,
    plyNumber: nextPlayerPly,
    playerTurnCount: nextPlayerTurnCount,
    currentRoll: nextPlayerRoll,
    playerRemainingMs: nextPlayerRemainingMs,
    botRemainingMs: activeGame.botRemainingMs,
    turnStartedAtMs,
    lastBotMoves: botMoves,
    ...(botLine ? { botLine } : {}),
  };

  const updatedRun: StoredRunState = {
    ...run,
    activeGame: updatedGame,
    updatedAtMs: turnStartedAtMs,
  };
  const cas = await dbSaveRunCas(updatedRun, run.revision);
  if (!cas.committed || !cas.run) {
    throw new HttpError(
      409,
      'Turn conflicted with a concurrent update; reload current run state',
    );
  }

  const hunt = getCommunityHuntStatus(
    await dbGetCommunityHuntCount(run.dayKey),
  );
  return {
    serverNowMs: deps.now(),
    run: await toPublicRunWithRival(cas.run),
    lastPlayerMoves: req.moves,
    lastBotMoves: botMoves,
    ...(botLine ? { botLine } : {}),
    communityHuntCount: hunt.count,
    communityHuntTarget: hunt.target,
    communityHuntBadge: hunt.badgeLabel,
  };
}

async function handleStageTerminal(
  run: StoredRunState,
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
    return commitStageWin({
      run,
      activeGame,
      reason: terminalResult.reason,
      playerTurnCount,
      lastPlayerMoves,
      lastBotMoves,
      nowMs,
      deps,
    });
  }

  if (terminalResult.winner === null) {
    return commitStageDraw({
      run,
      activeGame,
      reason: terminalResult.reason,
      playerTurnCount,
      lastPlayerMoves,
      lastBotMoves,
      nowMs,
      deps,
    });
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
  const hunt = getCommunityHuntStatus(
    await dbGetCommunityHuntCount(run.dayKey),
  );
  return {
    serverNowMs: deps.now(),
    run: toPublicRunState(finishedRun),
    lastPlayerMoves,
    lastBotMoves,
    botLine,
    stageOutcome: 'loss',
    outcomeReason: terminalResult.reason,
    communityHuntCount: hunt.count,
    communityHuntTarget: hunt.target,
    communityHuntBadge: hunt.badgeLabel,
  };
}

async function commitStageWin(params: {
  readonly run: StoredRunState;
  readonly activeGame: ActiveGameSnapshot;
  readonly reason: GameTerminalResult['reason'];
  readonly playerTurnCount: number;
  readonly lastPlayerMoves: readonly string[];
  readonly lastBotMoves: readonly string[];
  readonly nowMs: number;
  readonly deps: ServerDeps;
}): Promise<SubmitTurnRsp> {
  const { run, activeGame, playerTurnCount, nowMs, deps } = params;
  const { boss } = activeGame.opponent;
  const entry: StageChronicleEntry = {
    stage: activeGame.stage,
    bossId: boss.id,
    bossName: boss.name,
    outcome: 'win',
    turns: playerTurnCount,
    reason: params.reason,
  };
  const nextStage = activeGame.stage + 1;
  const progressedRun: StoredRunState = {
    ...run,
    status: 'paused_between_games',
    currentStage: nextStage,
    wins: run.wins + 1,
    totalTurns: run.totalTurns + playerTurnCount,
    chronicle: [...run.chronicle, entry],
    activeGame: null,
    updatedAtMs: nowMs,
  };

  const cas = await dbSaveRunCas(progressedRun, run.revision);
  if (!cas.committed || !cas.run) {
    throw new HttpError(
      409,
      'Turn conflicted with a concurrent update; reload current run state',
    );
  }

  let rawHuntCount = await dbGetCommunityHuntCount(cas.run.dayKey);
  if (activeGame.stage === 6) {
    const huntRes = await dbRecordCommunityHuntWin(
      cas.run.dayKey,
      cas.run.playerKey,
      cas.run.isGuest,
    );
    rawHuntCount = huntRes.count;
  }
  const hunt = getCommunityHuntStatus(rawHuntCount);

  const [{ dailyRank, isNewDailyBest }, nextStageEpitaph] = await Promise.all([
    dbRecordLeaderboardRun(cas.run, nowMs),
    dbGetStageEpitaph(cas.run.dayKey, nextStage),
  ]);

  const enrichedRun: StoredRunState = {
    ...cas.run,
    nextStageEpitaph,
    ...(dailyRank !== null ? { dailyRank } : {}),
    ...(isNewDailyBest ? { isNewDailyBest: true } : {}),
  };
  const metaCas = await dbSaveRunCas(enrichedRun, cas.run.revision);
  if (!metaCas.committed && !metaCas.run) {
    throw new HttpError(
      409,
      'Run state changed concurrently; reload current run state',
    );
  }
  const finalRun = metaCas.run ?? enrichedRun;

  const botLine = pickCharacterLine(
    boss.id,
    'loss',
    undefined,
    deps.random,
  ).text;

  return {
    serverNowMs: deps.now(),
    run: await toPublicRunWithRival(finalRun),
    lastPlayerMoves: params.lastPlayerMoves,
    lastBotMoves: params.lastBotMoves,
    botLine,
    stageOutcome: 'win',
    outcomeReason: params.reason,
    communityHuntCount: hunt.count,
    communityHuntTarget: hunt.target,
    communityHuntBadge: hunt.badgeLabel,
  };
}

async function commitStageDraw(params: {
  readonly run: StoredRunState;
  readonly activeGame: ActiveGameSnapshot;
  readonly reason: GameTerminalResult['reason'];
  readonly playerTurnCount: number;
  readonly lastPlayerMoves: readonly string[];
  readonly lastBotMoves: readonly string[];
  readonly nowMs: number;
  readonly deps: ServerDeps;
}): Promise<SubmitTurnRsp> {
  const { run, activeGame, playerTurnCount, nowMs, deps } = params;
  const { boss } = activeGame.opponent;
  const entry: StageChronicleEntry = {
    stage: activeGame.stage,
    bossId: boss.id,
    bossName: boss.name,
    outcome: 'draw',
    turns: playerTurnCount,
    reason: params.reason,
  };
  const drawnRun: StoredRunState = {
    ...run,
    status: 'paused_between_games',
    chronicle: [...run.chronicle, entry],
    activeGame: null,
    updatedAtMs: nowMs,
  };
  const cas = await dbSaveRunCas(drawnRun, run.revision);
  if (!cas.committed || !cas.run) {
    throw new HttpError(
      409,
      'Turn conflicted with a concurrent update; reload current run state',
    );
  }

  const [nextStageEpitaph, rawHuntCount] = await Promise.all([
    dbGetStageEpitaph(cas.run.dayKey, activeGame.stage),
    dbGetCommunityHuntCount(cas.run.dayKey),
  ]);
  const hunt = getCommunityHuntStatus(rawHuntCount);
  const enrichedRun: StoredRunState = { ...cas.run, nextStageEpitaph };
  const metaCas = await dbSaveRunCas(enrichedRun, cas.run.revision);
  if (!metaCas.committed && !metaCas.run) {
    throw new HttpError(
      409,
      'Run state changed concurrently; reload current run state',
    );
  }
  const finalRun = metaCas.run ?? enrichedRun;

  const botLine = pickCharacterLine(
    boss.id,
    'draw',
    undefined,
    deps.random,
  ).text;

  return {
    serverNowMs: deps.now(),
    run: await toPublicRunWithRival(finalRun),
    lastPlayerMoves: params.lastPlayerMoves,
    lastBotMoves: params.lastBotMoves,
    botLine,
    stageOutcome: 'draw',
    outcomeReason: params.reason,
    communityHuntCount: hunt.count,
    communityHuntTarget: hunt.target,
    communityHuntBadge: hunt.badgeLabel,
  };
}

async function finalizeLossRun(
  run: StoredRunState,
  playerTurnCount: number,
  reason: GameTerminalResult['reason'],
  deps: ServerDeps,
): Promise<StoredRunState> {
  const nowMs = deps.now();
  const stage = run.activeGame?.stage ?? run.currentStage;
  const opponent = run.activeGame?.opponent ?? getStageOpponent(stage);

  const entry: StageChronicleEntry = {
    stage,
    bossId: opponent.boss.id,
    bossName: opponent.boss.name,
    outcome: 'loss',
    turns: playerTurnCount,
    reason,
  };
  const updatedChronicle = [...run.chronicle, entry];
  const candidateRun: StoredRunState = {
    ...run,
    status: 'finished',
    chronicle: updatedChronicle,
    activeGame: null,
    updatedAtMs: nowMs,
    completedAtMs: nowMs,
  };

  const cas = await dbSaveRunCas(candidateRun, run.revision);
  if (!cas.committed || !cas.run) {
    if (cas.run?.status === 'finished') {
      return cas.run;
    }
    throw new HttpError(
      409,
      'Run state changed concurrently before finishing; reload run state',
    );
  }

  // Only the winning CAS caller records stage death and updates leaderboards.
  await dbRecordStageDeath(
    cas.run.dayKey,
    stage,
    cas.run.username,
    playerTurnCount,
  );
  return enrichAndSaveFinishedRun(cas.run, cas.run.completedAtMs ?? nowMs);
}

async function retirePausedRunWithoutDeath(
  run: StoredRunState,
  deps: ServerDeps,
): Promise<StoredRunState> {
  const nowMs = deps.now();
  const candidateRun: StoredRunState = {
    ...run,
    status: 'finished',
    activeGame: null,
    updatedAtMs: nowMs,
    completedAtMs: nowMs,
  };

  const cas = await dbSaveRunCas(candidateRun, run.revision);
  if (!cas.committed || !cas.run) {
    if (cas.run?.status === 'finished') {
      return cas.run;
    }
    throw new HttpError(
      409,
      'Run state changed concurrently before resigning; reload run state',
    );
  }

  return enrichAndSaveFinishedRun(cas.run, cas.run.completedAtMs ?? nowMs);
}

async function enrichAndSaveFinishedRun(
  finishedBase: StoredRunState,
  completedAtMs: number,
): Promise<StoredRunState> {
  const { dailyRank, isNewDailyBest } = await dbRecordLeaderboardRun(
    finishedBase,
    completedAtMs,
  );
  const shareCardText = formatSpoilerFreeShareCard({
    dayKey: finishedBase.dayKey,
    openingRoll: finishedBase.openingRoll,
    firstTry: finishedBase.firstTry,
    wins: finishedBase.wins,
    totalTurns: finishedBase.totalTurns,
    rank: dailyRank,
    stages: finishedBase.chronicle.map((item) => ({
      stage: item.stage,
      bossName: item.bossName,
      outcome: item.outcome,
      turns: item.turns,
    })),
  });

  const { dailyRank: _oldRank, ...rest } = finishedBase;
  const enriched: StoredRunState = {
    ...rest,
    ...(dailyRank !== null ? { dailyRank } : {}),
    ...(isNewDailyBest || finishedBase.isNewDailyBest
      ? { isNewDailyBest: true }
      : {}),
    shareCardText,
  };
  const cas = await dbSaveRunCas(enriched, finishedBase.revision, {
    allowAlreadyFinished: true,
  });
  return cas.committed && cas.run ? cas.run : enriched;
}

async function toPublicRunWithRival(
  run: StoredRunState,
  precomputedRival?: Awaited<ReturnType<typeof dbGetNextRival>>,
): Promise<ReturnType<typeof toPublicRunState>> {
  const publicRun = toPublicRunState(run);
  if (run.status === 'finished') {
    return publicRun;
  }
  const rivalTarget =
    precomputedRival !== undefined
      ? precomputedRival
      : await dbGetNextRival(run.dayKey, run.playerKey, {
          wins: run.wins,
          totalTurns: run.totalTurns,
          firstTry: run.firstTry,
        });
  return {
    ...publicRun,
    rivalTarget,
  };
}

async function syncClockExpiration(
  run: StoredRunState,
  deps: ServerDeps,
): Promise<StoredRunState> {
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
  assertValidMutatingIdentity(identity);

  const run = await requireAuthorizedRun(req.runId, identity);
  if (run.status === 'in_game') {
    throw new HttpError(
      400,
      'Pause is only allowed between games, never during an active clock',
    );
  }
  if (run.status !== 'paused_between_games') {
    throw new HttpError(409, 'Only paused between-game runs can be paused');
  }
  const currentRunId = await dbGetCurrentRunId(run.dayKey, identity.playerKey);
  if (currentRunId !== run.runId) {
    throw new HttpError(409, 'Cannot pause an older run that is not current');
  }

  const cas = await dbSaveRunCas(
    { ...run, updatedAtMs: deps.now() },
    run.revision,
  );
  if (!cas.committed || !cas.run) {
    throw new HttpError(409, 'Run state changed concurrently; reload state');
  }
  return { run: toPublicRunState(cas.run) };
}

async function routeResignRun(
  req: ResignRunReq,
  deps: ServerDeps,
): Promise<ResignRunRsp> {
  if (!req.runId) {
    throw new HttpError(400, 'Missing runId');
  }
  const identity = currentIdentity(req.guestId);
  assertValidMutatingIdentity(identity);

  const loaded = await requireAuthorizedRun(req.runId, identity);
  const run = await syncClockExpiration(loaded, deps);
  if (run.status === 'finished') {
    return { run: toPublicRunState(run) };
  }
  const finished =
    run.status === 'paused_between_games'
      ? await retirePausedRunWithoutDeath(run, deps)
      : await finalizeLossRun(
          run,
          run.activeGame?.playerTurnCount ?? 0,
          'resigned',
          deps,
        );
  return { run: toPublicRunState(finished) };
}

async function routeShareComment(
  req: ShareCommentReq,
): Promise<ShareCommentRsp> {
  if (!req.runId) {
    throw new HttpError(400, 'Missing runId');
  }
  const identity = currentIdentity(req.guestId);
  assertValidMutatingIdentity(identity);

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
    console.error('Failed to submit share comment:', err);
    return {
      posted: false,
      shareText,
      reason: 'Could not submit comment directly; copy and paste below.',
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

function assertValidMutatingIdentity(identity: PlayerIdentity): void {
  if (!identity.isAuthenticated && !identity.hasValidGuestId) {
    throw new HttpError(
      400,
      'valid user session or guest identity is required',
    );
  }
}

async function requireAuthorizedRun(
  runId: string,
  identity: PlayerIdentity,
): Promise<StoredRunState> {
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
  const raw = await readRequestText(reqMsg, MAX_BODY_BYTES);
  if (!raw.trim()) {
    return {} as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON payload');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as T;
}

async function readRequestText(
  reqMsg: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    reqMsg.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        reqMsg.pause();
        fail(new HttpError(413, 'Request payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    reqMsg.on('error', (err) =>
      fail(err instanceof Error ? err : new Error(String(err))),
    );
    reqMsg.on('aborted', () => fail(new HttpError(400, 'Request aborted')));
    reqMsg.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function drainRequestBody(reqMsg: IncomingMessage): Promise<void> {
  if (reqMsg.readableEnded) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    reqMsg.on('error', (err) =>
      finish(err instanceof Error ? err : new Error(String(err))),
    );
    reqMsg.on('close', () => finish());
    reqMsg.on('end', () => finish());
    reqMsg.resume();
  });
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
