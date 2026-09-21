import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from './app.js';
import { parseConfig } from './config.js';
import { migrate } from './migrate.js';
import { createBlobStore } from './storage/index.js';
import { sweepExpiredAttachments } from './routes/attachments.js';
import { sweepExpiredExports } from './routes/exports.js';
import { sweepExpiredAdmissions } from './routes/invites.js';
import { sweepPendingBlobDeletions } from './storage/pending-deletions.js';
import { sweepCommunityDeletions, sweepCommunityDeletionTombstones } from './deletion-worker.js';

const config = parseConfig(process.env);
await migrate(config.databaseUrl);
const pool = new Pool({ connectionString: config.databaseUrl });
const blobStore = createBlobStore(config);
const app = createCommunityApp({ config, pool, blobStore });
const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/', serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) }));
app.get(
  '/join',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/pairing',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/c/:communityId',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/c/:communityId/*',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
const server = serve({ fetch: app.fetch, port: config.port });
const cleanup = setInterval(() => {
  void sweepExpiredAttachments(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community attachment cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepExpiredExports(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community export cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepExpiredAdmissions(pool).catch((error: unknown) => {
    console.error(
      'Community admission cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepPendingBlobDeletions(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community pending blob cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepCommunityDeletions(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community deletion unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepCommunityDeletionTombstones(pool).catch((error: unknown) => {
    console.error(
      'Community deletion receipt cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
}, 60_000);
cleanup.unref();
const stop = () =>
  server.close(() => {
    clearInterval(cleanup);
    void pool.end();
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
