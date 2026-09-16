/** Run packaged community and local-agent proof inside an internal Docker network. */
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

const { fetch, AbortSignal } = globalThis;
const root = '/data/acceptance';
await mkdir(root, { recursive: true, mode: 0o700 });
const databaseUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
assert(databaseUrl, 'COMMUNITY_TEST_DATABASE_URL must name the isolated PostgreSQL service');
const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const suffix = randomBytes(8).toString('hex');
const databases = ['a', 'b'].map((name) => `community_acceptance_${name}_${suffix}`);
const children = new Map();
const created = [];
const secrets = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
const environment = {
  PATH: process.env.PATH,
  HOME: '/data/home',
  PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright',
  NODE_ENV: 'production',
};
await mkdir(environment.HOME, { recursive: true, mode: 0o700 });

async function stop(name) {
  const child = children.get(name);
  if (!child) return;
  children.delete(name);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function start(name, command, args, cwd, env, health) {
  const output = await open(`${root}/${name}.log`, 'a', 0o600);
  const child = spawn(command, args, {
    cwd,
    env: { ...environment, ...env },
    stdio: ['ignore', output.fd, output.fd],
  });
  children.set(name, child);
  child.once('exit', () => {
    // An older process may exit after its replacement has already started.
    if (children.get(name) === child) children.delete(name);
  });
  await output.close();
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
    if (children.get(name) === child) children.delete(name);
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert(
      child.exitCode === null && child.signalCode === null,
      `${name} exited before it was ready; inspect its private log`
    );
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* Poll only the process this runner just started. */
    }
    await delay(100);
  }
  throw new Error(`${name} did not become healthy; inspect its private log`);
}

async function networkProof() {
  assert.equal((await admin.query('SELECT 1 AS reachable')).rows[0].reachable, 1);
  const publicSocket = await new Promise((resolve) => {
    const socket = connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(3000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  assert.equal(
    publicSocket,
    false,
    'Acceptance container has public IP egress; use an internal Docker network'
  );
  let dorkosReached = false;
  try {
    await fetch('https://dorkos.ai', { signal: AbortSignal.timeout(3000) });
    dorkosReached = true;
  } catch {
    /* Expected only in the sealed runtime network. */
  }
  assert.equal(dorkosReached, false, 'Acceptance container can reach DorkOS Cloud');
  await writeFile(
    `${root}/network-proof.json`,
    JSON.stringify({ postgresReachable: true, publicIpReachable: false, dorkosReachable: false }),
    { mode: 0o600 }
  );
}

const definitions = new Map();
let control;
try {
  await networkProof();
  for (const [index, name] of ['a', 'b'].entries()) {
    await admin.query(`CREATE DATABASE ${databases[index]}`);
    created.push(databases[index]);
    const url = new URL(databaseUrl);
    url.pathname = `/${databases[index]}`;
    const port = 6481 + index;
    const origin = `http://127.0.0.1:${port}`;
    await mkdir(`${root}/blobs-${name}`, { recursive: true });
    definitions.set(name, [
      'node',
      ['dist-server/main.js'],
      '/packaged-community',
      {
        ...(name === 'a' ? { COMMUNITY_TEST_RUNTIME: 'true' } : {}),
        COMMUNITY_DATABASE_URL: url.toString(),
        COMMUNITY_PUBLIC_URL: origin,
        COMMUNITY_PORT: String(port),
        COMMUNITY_AUTH_SECRET: randomBytes(32).toString('hex'),
        COMMUNITY_INVITE_SECRET: randomBytes(32).toString('hex'),
        COMMUNITY_BOOTSTRAP_SECRET: secrets[index],
        COMMUNITY_STORAGE_PATH: `${root}/blobs-${name}`,
      },
      `${origin}/health`,
    ]);
  }
  await mkdir(`${root}/agents`, { recursive: true });
  definitions.set('local', [
    'node',
    ['dist/bin/cli.js', '--port', '6483', '--no-open'],
    '/packaged-cli/node_modules/dorkos',
    {
      DORK_HOME: `${root}/local-home`,
      DORKOS_HOST: '127.0.0.1',
      DORKOS_BOUNDARY: root,
      DORKOS_TEST_RUNTIME: 'true',
      DORKOS_TEST_RUNTIME_CLAUDE_ALIAS: 'true',
      DORKOS_RELAY_ENABLED: 'true',
      DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    },
    'http://127.0.0.1:6483/api/health',
  ]);
  for (const [name, definition] of definitions) await start(name, ...definition);
  const testMode = await fetch('http://127.0.0.1:6483/api/test/reset', { method: 'POST' });
  assert(
    testMode.ok,
    'Packaged server must expose deterministic test runtime; no live inference fallback is allowed'
  );
  // This loopback-only test control is outside both products. Control only the
  // owned child while preserving its database, key material and files.
  let restarting = false;
  control = createServer(async (request, response) => {
    const match = request.url?.match(/^\/(restart|stop|start)\/(a|b|local)$/);
    const [, action, name] = match ?? [];
    if (request.method !== 'POST' || !name) {
      response.writeHead(404).end();
      return;
    }
    if (restarting) {
      response.writeHead(409).end();
      return;
    }
    restarting = true;
    try {
      if (action !== 'start') await stop(name);
      if (action !== 'stop') {
        if (children.has(name)) {
          response.writeHead(409).end('Owned service is already running');
          return;
        }
        await start(name, ...definitions.get(name));
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ action, service: name, completed: true }));
    } catch {
      response.writeHead(500).end('Owned service control failed');
    } finally {
      restarting = false;
    }
  });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(6484, '127.0.0.1', resolve);
  });
  const test = spawn(
    process.execPath,
    [
      '/work/apps/community/node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'acceptance/playwright.config.ts',
    ],
    {
      cwd: '/work/apps/community',
      env: {
        ...environment,
        COMMUNITY_ACCEPTANCE_ROOT: root,
        COMMUNITY_ACCEPTANCE_A_URL: 'http://127.0.0.1:6481',
        COMMUNITY_ACCEPTANCE_B_URL: 'http://127.0.0.1:6482',
        COMMUNITY_ACCEPTANCE_LOCAL_URL: 'http://127.0.0.1:6483',
        COMMUNITY_ACCEPTANCE_CONTROL_URL: 'http://127.0.0.1:6484',
        COMMUNITY_ACCEPTANCE_A_SECRET: secrets[0],
        COMMUNITY_ACCEPTANCE_B_SECRET: secrets[1],
      },
      stdio: 'inherit',
    }
  );
  children.set('driver', test);
  const code = await new Promise((resolve, reject) => {
    test.once('exit', resolve);
    test.once('error', reject);
  });
  assert.equal(code, 0, 'Packaged acceptance driver failed');
  const report = JSON.parse(await readFile(`${root}/playwright-report.json`, 'utf8'));
  assert(report.stats?.expected > 0, 'Acceptance report contains no passed tests');
  for (const count of ['unexpected', 'skipped', 'flaky']) {
    assert.equal(report.stats[count], 0, `Acceptance report contains ${count} tests`);
  }
} finally {
  control?.closeAllConnections();
  control?.close();
  for (const name of [...children.keys()].reverse()) await stop(name);
  for (const name of created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
