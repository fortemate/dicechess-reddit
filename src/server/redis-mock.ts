import { redis } from '@devvit/web/server';

export interface RedisMockController {
  readonly clear: () => void;
  readonly restore: () => void;
}

class InMemoryRedisBacking {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly versions = new Map<string, number>();

  clear(): void {
    this.strings.clear();
    this.hashes.clear();
    this.versions.clear();
  }

  bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  getHash(key: string): Map<string, string> {
    let map = this.hashes.get(key);
    if (!map) {
      map = new Map<string, string>();
      this.hashes.set(key, map);
    }
    return map;
  }

  set(key: string, value: string): string {
    this.strings.set(key, value);
    this.bump(key);
    return 'OK';
  }

  incrBy(key: string, amount: number): number {
    const next = Number(this.strings.get(key) ?? '0') + amount;
    this.strings.set(key, `${next}`);
    this.bump(key);
    return next;
  }

  hSet(key: string, fieldValues: Record<string, string>): number {
    const map = this.getHash(key);
    let added = 0;
    for (const [field, value] of Object.entries(fieldValues)) {
      if (!map.has(field)) added += 1;
      map.set(field, value);
    }
    this.bump(key);
    return added;
  }

  hIncrBy(key: string, field: string, amount: number): number {
    const map = this.getHash(key);
    const next = Number(map.get(field) ?? '0') + amount;
    map.set(field, `${next}`);
    this.bump(key);
    return next;
  }

  del(keys: readonly string[]): number {
    for (const key of keys) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.bump(key);
    }
    return keys.length;
  }
}

interface MockTx {
  multi(): Promise<void>;
  set(key: string, value: string): Promise<MockTx>;
  incrBy(key: string, amount: number): Promise<MockTx>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<MockTx>;
  hIncrBy(key: string, field: string, amount: number): Promise<MockTx>;
  del(...delKeys: string[]): Promise<MockTx>;
  unwatch(): Promise<MockTx>;
  discard(): Promise<void>;
  watch(...moreKeys: string[]): Promise<MockTx>;
  exec(): Promise<unknown[]>;
}

function createWatchedTx(
  backing: InMemoryRedisBacking,
  keys: readonly string[],
) {
  const watched = new Map<string, number>();
  for (const key of keys) {
    watched.set(key, backing.versions.get(key) ?? 0);
  }
  let multiStarted = false;
  const queued: Array<() => unknown> = [];

  const tx: MockTx = {
    multi(): Promise<void> {
      multiStarted = true;
      return Promise.resolve();
    },
    set(key: string, value: string): Promise<MockTx> {
      queued.push(() => backing.set(key, value));
      return Promise.resolve(tx);
    },
    incrBy(key: string, amount: number): Promise<MockTx> {
      queued.push(() => backing.incrBy(key, amount));
      return Promise.resolve(tx);
    },
    hSet(key: string, fieldValues: Record<string, string>): Promise<MockTx> {
      queued.push(() => backing.hSet(key, fieldValues));
      return Promise.resolve(tx);
    },
    hIncrBy(key: string, field: string, amount: number): Promise<MockTx> {
      queued.push(() => backing.hIncrBy(key, field, amount));
      return Promise.resolve(tx);
    },
    del(...delKeys: string[]): Promise<MockTx> {
      queued.push(() => backing.del(delKeys));
      return Promise.resolve(tx);
    },
    unwatch(): Promise<MockTx> {
      watched.clear();
      queued.length = 0;
      return Promise.resolve(tx);
    },
    discard(): Promise<void> {
      multiStarted = false;
      watched.clear();
      queued.length = 0;
      return Promise.resolve();
    },
    watch(...moreKeys: string[]): Promise<MockTx> {
      for (const key of moreKeys) {
        watched.set(key, backing.versions.get(key) ?? 0);
      }
      return Promise.resolve(tx);
    },
    exec(): Promise<unknown[]> {
      if (!multiStarted) {
        return Promise.reject(new Error('Must call multi() before exec()'));
      }
      for (const [key, version] of watched.entries()) {
        if ((backing.versions.get(key) ?? 0) !== version) {
          return Promise.resolve([]);
        }
      }
      return Promise.resolve(queued.map((op) => op()));
    },
  };
  return tx as unknown as Awaited<ReturnType<typeof redis.watch>>;
}

/** Installs an in-memory transactional mock onto `@devvit/web/server`'s `redis` singleton. */
export function installRedisMock(options?: {
  readonly yieldOnGet?: boolean;
}): RedisMockController {
  const backing = new InMemoryRedisBacking();
  const original = {
    get: redis.get.bind(redis),
    set: redis.set.bind(redis),
    incrBy: redis.incrBy.bind(redis),
    del: redis.del.bind(redis),
    hSet: redis.hSet.bind(redis),
    hIncrBy: redis.hIncrBy.bind(redis),
    hGetAll: redis.hGetAll.bind(redis),
    hLen: redis.hLen.bind(redis),
    watch: redis.watch.bind(redis),
  };

  redis.get = async (key) => {
    if (options?.yieldOnGet) {
      await Promise.resolve();
    }
    return backing.strings.get(key);
  };
  redis.set = (key, value) => Promise.resolve(backing.set(key, value));
  redis.incrBy = (key, amount) => Promise.resolve(backing.incrBy(key, amount));
  redis.del = (...keys) => {
    backing.del(keys);
    return Promise.resolve();
  };
  redis.hSet = (key, fieldValues) =>
    Promise.resolve(backing.hSet(key, fieldValues));
  redis.hIncrBy = (key, field, amount) =>
    Promise.resolve(backing.hIncrBy(key, field, amount));
  redis.hGetAll = (key) => {
    const map = backing.hashes.get(key);
    return Promise.resolve(map ? Object.fromEntries(map.entries()) : {});
  };
  redis.hLen = (key) => Promise.resolve(backing.hashes.get(key)?.size ?? 0);
  redis.watch = ((...keys: string[]) =>
    Promise.resolve(createWatchedTx(backing, keys))) as typeof redis.watch;

  return {
    clear: () => backing.clear(),
    restore: () => {
      redis.get = original.get;
      redis.set = original.set;
      redis.incrBy = original.incrBy;
      redis.del = original.del;
      redis.hSet = original.hSet;
      redis.hIncrBy = original.hIncrBy;
      redis.hGetAll = original.hGetAll;
      redis.hLen = original.hLen;
      redis.watch = original.watch;
    },
  };
}
