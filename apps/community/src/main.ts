import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from './app.js';
import { parseConfig } from './config.js';
import { migrate } from './migrate.js';

const config = parseConfig(process.env);
await migrate(config.databaseUrl);
const pool = new Pool({ connectionString: config.databaseUrl });
const app = createCommunityApp({ config, pool });
const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/', serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) }));
app.get(
  '/pairing',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
const server = serve({ fetch: app.fetch, port: config.port });
const stop = () =>
  server.close(() => {
    void pool.end();
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
