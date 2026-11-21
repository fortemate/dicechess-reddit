import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { reddit } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type GetDailyStateRsp,
} from '../shared/api.ts';
import {
  GAUNTLET_LADDER,
  getDailyOpeningRoll,
  INCREMENT_MS,
  INITIAL_CLOCK_MS,
  utcDayKey,
} from '../shared/daily.ts';
import { dbGetCommunityHuntCount, DEFAULT_HUNT_TARGET } from './db.ts';

type AnyRsp = GetDailyStateRsp | UiResponse | TriggerResponse | ErrorRsp;

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJson(500, { error: msg, status: 500 } satisfies ErrorRsp, rspMsg);
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpointPath = (reqMsg.url ?? '/').split('?')[0]?.slice(1) ?? '';
  const endpoint = endpointPath as Endpoint;
  const method = (EndpointMethod as Record<string, 'GET' | 'POST'>)[endpoint];

  let rsp: AnyRsp;
  if (!method || method !== reqMsg.method) {
    rsp = { error: 'not found', status: 404 };
  } else {
    switch (endpoint) {
      case Endpoint.GetDailyState:
        rsp = await routeGetDailyState();
        break;
      case Endpoint.OnMenuNewPost:
        await drainRequestBody(reqMsg);
        rsp = await routeMenuNewPost();
        break;
      case Endpoint.OnAppInstall:
        await drainRequestBody(reqMsg);
        rsp = await routeAppInstall();
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

async function routeGetDailyState(): Promise<GetDailyStateRsp> {
  const dayKey = utcDayKey();
  const dailyBoss = GAUNTLET_LADDER[GAUNTLET_LADDER.length - 1]!;
  return {
    dayKey,
    openingRoll: getDailyOpeningRoll(dayKey),
    dailyBoss,
    initialClockMs: INITIAL_CLOCK_MS,
    incrementMs: INCREMENT_MS,
    communityHuntCount: await dbGetCommunityHuntCount(dayKey),
    communityHuntTarget: DEFAULT_HUNT_TARGET,
  };
}

async function routeMenuNewPost(): Promise<UiResponse> {
  const dayKey = utcDayKey();
  const post = await reddit.submitCustomPost({
    title: `Dice Chess Daily — ${dayKey}`,
  });
  return {
    showToast: { text: `Post ${post.id} created.`, appearance: 'success' },
    navigateTo: post.url,
  };
}

async function routeAppInstall(): Promise<TriggerResponse> {
  const dayKey = utcDayKey();
  await reddit.submitCustomPost({
    title: `Dice Chess Daily — ${dayKey}`,
  });
  return {};
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
