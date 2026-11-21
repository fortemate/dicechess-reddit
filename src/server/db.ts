import { redis } from '@devvit/web/server';

export const DEFAULT_HUNT_TARGET = 10;

export async function dbGetCommunityHuntCount(dayKey: string): Promise<number> {
  const raw = await redis.get(communityHuntKey(dayKey));
  const parsed = Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function dbIncCommunityHuntCount(
  dayKey: string,
  amount = 1,
): Promise<number> {
  return redis.incrBy(communityHuntKey(dayKey), amount);
}

function communityHuntKey(dayKey: string): string {
  return `hunt:${dayKey}:count`;
}
