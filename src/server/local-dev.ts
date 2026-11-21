import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { type Context, reddit, runWithContext } from '@devvit/web/server';
import { installRedisMock } from './redis-mock.ts';
import { createAppHandler } from './server.ts';

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function installLocalPlatformMocks(): void {
  installRedisMock();
  reddit.submitComment = ((opts: { id: string; text: string }) => {
    console.info(
      `\n[local-dev] Simulated Reddit comment on ${opts.id}:\n${opts.text}\n`,
    );
    return Promise.resolve({} as never);
  }) as typeof reddit.submitComment;
}

async function serveStaticFile(
  pathname: string,
  rsp: ServerResponse,
): Promise<boolean> {
  const relPath =
    pathname === '/' ? 'splash.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relPath);
  if (
    resolved !== PUBLIC_DIR &&
    !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)
  ) {
    rsp.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    rsp.end('Forbidden');
    return true;
  }

  try {
    const content = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    rsp.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    rsp.end(content);
    return true;
  } catch {
    return false;
  }
}

installLocalPlatformMocks();
const apiHandler = createAppHandler();

const server = createServer(
  async (req: IncomingMessage, rsp: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/internal/')
    ) {
      const asGuest = url.searchParams.get('guest') === '1';
      const devCtx = {
        appName: 'dicechess-daily',
        postId: 't3_local_preview',
        userId: asGuest ? undefined : 't2_local_dev',
        username: asGuest ? undefined : 'local_hero',
      } as unknown as Context;
      await runWithContext(devCtx, () => apiHandler(req, rsp));
      return;
    }

    const served = await serveStaticFile(url.pathname, rsp);
    if (!served) {
      rsp.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      rsp.end('Not found');
    }
  },
);

server.listen(PORT, HOST, () => {
  console.info(
    `Dice Chess Daily local dev server running:\n` +
      `  Splash Preview: http://${HOST}:${PORT}/splash.html\n` +
      `  Game View:      http://${HOST}:${PORT}/game.html`,
  );
});
