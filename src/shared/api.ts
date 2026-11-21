import type {
  BossCharacter,
  DailyOpeningRoll,
  StageOpponent,
} from './daily.ts';
import type { GameTerminalResult, Side } from './engine.ts';

export type ErrorRsp = {
  readonly error: string;
  readonly status: number;
};

export type StageOutcome = 'win' | 'draw' | 'loss';

export type StageChronicleEntry = {
  readonly stage: number;
  readonly bossId: BossCharacter['id'];
  readonly bossName: string;
  readonly outcome: StageOutcome;
  readonly turns: number;
  readonly reason: GameTerminalResult['reason'];
};

export type StageEpitaph = {
  readonly stage: number;
  readonly bossId: BossCharacter['id'];
  readonly attempts: number;
  readonly losses: number;
  readonly eliminationRatePct: number;
  readonly lastFallenUser?: string;
  readonly lastFallenTurns?: number;
};

export type ActiveGameSnapshot = {
  readonly stage: number;
  readonly opponent: StageOpponent;
  readonly baseFen: string;
  readonly plyNumber: number;
  readonly playerTurnCount: number;
  readonly currentRoll: DailyOpeningRoll;
  readonly playerRemainingMs: number;
  readonly botRemainingMs: number;
  readonly turnStartedAtMs: number;
  readonly lastBotMoves: readonly string[];
  readonly botLine?: string;
};

export type RunStatus = 'in_game' | 'paused_between_games' | 'finished';

export type RunState = {
  readonly runId: string;
  readonly dayKey: string;
  readonly playerKey: string;
  readonly username: string;
  readonly isGuest: boolean;
  readonly attemptNumber: number;
  readonly firstTry: boolean;
  readonly openingRoll: DailyOpeningRoll;
  readonly status: RunStatus;
  readonly currentStage: number;
  readonly wins: number;
  readonly totalTurns: number;
  readonly chronicle: readonly StageChronicleEntry[];
  readonly activeGame: ActiveGameSnapshot | null;
  readonly nextStageEpitaph?: StageEpitaph;
  readonly dailyRank?: number;
  readonly shareCardText?: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs?: number;
};

export type LeaderboardEntry = {
  readonly playerKey: string;
  readonly username: string;
  readonly isGuest: boolean;
  readonly wins: number;
  readonly totalTurns: number;
  readonly firstTry: boolean;
  readonly dayKey: string;
  readonly maxStage: number;
  readonly completedAtMs: number;
};

export type LeaderboardsBundle = {
  readonly dayKey: string;
  readonly weekKey: string;
  readonly monthKey: string;
  readonly yearKey: string;
  readonly day: readonly LeaderboardEntry[];
  readonly week: readonly LeaderboardEntry[];
  readonly month: readonly LeaderboardEntry[];
  readonly year: readonly LeaderboardEntry[];
};

export type GetDailyStateRsp = {
  readonly dayKey: string;
  readonly themeName: string;
  readonly openingRoll: DailyOpeningRoll;
  readonly dailyBoss: BossCharacter;
  readonly initialClockMs: number;
  readonly incrementMs: number;
  readonly communityHuntCount: number;
  readonly communityHuntTarget: number;
  readonly topLeaders: readonly LeaderboardEntry[];
  readonly stageEpitaphs: readonly StageEpitaph[];
  readonly playerUsername: string;
  readonly isGuest: boolean;
  readonly attemptsToday: number;
  readonly activeRun: RunState | null;
};

export type GetLeaderboardsRsp = LeaderboardsBundle;

export type StartRunReq = {
  readonly guestId?: string;
  readonly guestNickname?: string;
  readonly forceNew?: boolean;
};

export type StartRunRsp = {
  readonly run: RunState;
  readonly resumed: boolean;
};

export type SubmitTurnReq = {
  readonly guestId?: string;
  readonly runId: string;
  readonly plyNumber: number;
  readonly moves: readonly string[];
};

export type SubmitTurnRsp = {
  readonly run: RunState;
  readonly lastPlayerMoves: readonly string[];
  readonly lastBotMoves: readonly string[];
  readonly botLine?: string;
  readonly stageOutcome?: StageOutcome;
  readonly outcomeReason?: GameTerminalResult['reason'];
  readonly communityHuntCount: number;
  readonly communityHuntTarget: number;
};

export type PauseRunReq = {
  readonly guestId?: string;
  readonly runId: string;
};

export type PauseRunRsp = {
  readonly run: RunState;
};

export type ResignRunReq = {
  readonly guestId?: string;
  readonly runId: string;
};

export type ResignRunRsp = {
  readonly run: RunState;
};

export type ShareCommentReq = {
  readonly guestId?: string;
  readonly runId: string;
};

export type ShareCommentRsp = {
  readonly posted: boolean;
  readonly shareText: string;
  readonly reason?: string;
};

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint];
export const Endpoint = {
  GetDailyState: 'api/daily-state',
  GetLeaderboards: 'api/leaderboards',
  StartRun: 'api/run/start',
  SubmitTurn: 'api/run/turn',
  PauseRun: 'api/run/pause',
  ResignRun: 'api/run/resign',
  ShareComment: 'api/run/share-comment',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
} as const;

export const EndpointMethod = {
  [Endpoint.GetDailyState]: 'GET',
  [Endpoint.GetLeaderboards]: 'GET',
  [Endpoint.StartRun]: 'POST',
  [Endpoint.SubmitTurn]: 'POST',
  [Endpoint.PauseRun]: 'POST',
  [Endpoint.ResignRun]: 'POST',
  [Endpoint.ShareComment]: 'POST',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
} as const satisfies Record<string, 'GET' | 'POST'>;

export type ClientGameState = {
  readonly side: Side;
};
