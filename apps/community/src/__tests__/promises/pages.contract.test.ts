/**
 * Contract for the page routes (specs/server-merge step 1, DOR-2875): every path that opens the
 * space's web page, its built assets, and a short web address's one spelling. Links in mail, in
 * the DorkOS app and in people's bookmarks lead to these. The server is composed as `main.ts`
 * composes it and served over real HTTP; no page reads the database, so this runs in the unit
 * suite. A deliberate change updates this file in the same PR and says so in the PR description.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createCommunityApp } from '../../app.js';
import { parseConfig } from '../../config.js';
import { registerPages } from '../../pages/register.js';
import { PAGE_CSP } from '../../headers/security-headers.js';
import { contractSuite, type ContractCase, type ContractServer } from './contract.js';
import { CENSUS_ENV } from './route-census.js';

const INDEX = '<!doctype html><title>space page</title>';
const SCRIPT = 'console.log("space page");';
const SPACE = '7d1f4a2e-5b3c-4d6e-8f90-a1b2c3d4e5f6';

async function startPages(): Promise<ContractServer<Record<string, never>>> {
  const distDir = await mkdtemp(join(tmpdir(), 'community-pages-contract-'));
  await mkdir(join(distDir, 'assets'));
  await writeFile(join(distDir, 'index.html'), INDEX);
  await writeFile(join(distDir, 'assets', 'app.js'), SCRIPT);
  const config = parseConfig(CENSUS_ENV);
  // Never connected: no page reads the database.
  const pool = new Pool({ connectionString: config.databaseUrl });
  const app = createCommunityApp({ config, pool });
  registerPages(app, { distDir });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fixture: {},
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await rm(distDir, { recursive: true, force: true });
    },
  };
}

/** Every path that opens the page. */
const PAGES = [
  '/',
  '/host',
  '/join',
  '/claim',
  '/pairing',
  '/keep-ownership',
  '/owner-replacement',
  '/reset-password',
  '/email-sign-in',
  '/confirm-email',
  `/c/${SPACE}`,
  `/c/${SPACE}/channels/general`,
  '/acme-space',
  '/acme-space/channels/general',
];

contractSuite('pages', startPages, [
  ...PAGES.map((path): ContractCase<Record<string, never>> => ({
    name: `GET ${path} opens the page`,
    path,
    expect: {
      status: 200,
      // The page's content security policy (DOR-2957): only its own script, nothing inline.
      headers: { 'content-type': /^text\/html\b/u, 'content-security-policy': PAGE_CSP },
      text: /^<!doctype html><title>space page<\/title>$/u,
    },
  })),
  {
    name: 'GET /assets/:file serves the built asset',
    path: '/assets/app.js',
    expect: {
      status: 200,
      headers: { 'content-type': /javascript/u },
      text: /^console\.log\("space page"\);$/u,
    },
  },
  {
    name: 'GET /assets/:file that was not built is not found',
    path: '/assets/missing.js',
    expect: { status: 404 },
  },
  {
    name: 'a short address spelled another way moves for good to its one spelling',
    path: '/Acme-Space/channels?x=1',
    expect: { status: 301, headers: { location: '/acme-space/channels?x=1' } },
  },
  {
    name: 'a reserved path is never a short address',
    path: '/api',
    expect: { status: 404 },
  },
]);
