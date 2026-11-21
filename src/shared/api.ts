import type { BossCharacter, DailyOpeningRoll } from './daily.ts';

export type ErrorRsp = {
  readonly error: string;
  readonly status: number;
};

export type GetDailyStateRsp = {
  readonly dayKey: string;
  readonly openingRoll: DailyOpeningRoll;
  readonly dailyBoss: BossCharacter;
  readonly initialClockMs: number;
  readonly incrementMs: number;
  readonly communityHuntCount: number;
  readonly communityHuntTarget: number;
};

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint];
export const Endpoint = {
  GetDailyState: 'api/daily-state',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
} as const;

export const EndpointMethod = {
  [Endpoint.GetDailyState]: 'GET',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
} as const satisfies Record<string, 'GET' | 'POST'>;
