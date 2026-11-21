import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { type Context, redis, runWithContext } from '@devvit/web/server';
import {
  Endpoint,
  type ErrorRsp,
  type GetDailyStateRsp,
} from '../shared/api.ts';
import { utcDayKey } from '../shared/daily.ts';
import { onReq } from './server.ts';

let server: Server;
let serverURL: string;
const redisValues = new Map<string, string>();
const originalGet = redis.get.bind(redis);
const originalIncrBy = redis.incrBy.bind(redis);

describe('Devvit Web server endpoints', () => {
  before(async () => {
    redis.get = async (key) => redisValues.get(key) ?? undefined;
    redis.incrBy = async (key, amount) => {
      const next = Number(redisValues.get(key) ?? '0') + amount;
      redisValues.set(key, `${next}`);
      return next;
    };

    server = createServer(async (req, rsp) => {
      await runWithContext(
        {
          appName: 'dicechess-daily',
          postId: 't3_123',
          userId: 't2_123',
          username: 'player',
        } as unknown as Context,
        () => onReq(req, rsp),
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
    redis.incrBy = originalIncrBy;
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    redisValues.clear();
  });

  it('returns daily state with P+2 opening roll, Ashby boss, 3+2 clock, and hunt count', async () => {
    const today = utcDayKey();
    redisValues.set(`hunt:${today}:count`, '4');

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
