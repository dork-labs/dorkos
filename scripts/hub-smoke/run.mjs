#!/usr/bin/env node
/**
 * Hub image smoke test (DOR-2935): boots DorkOS in hub mode against a
 * stand-in for DorkOS Cloud and checks what Cloud relies on.
 *
 * 1. The hub refuses to boot without its instance key.
 * 2. With it, the health check answers on any Host, without the front-door
 *    proof, while everything else answers 503 because the hub is pooled.
 * 3. The hub reads its assignment with its key, confirms it, and serves.
 * 4. Once serving, a request needs exactly one front-door proof and the
 *    assigned Host, and neither secret is ever logged.
 *
 * Runs inside the `hub-smoke` image (`Dockerfile`), and anywhere `dorkos` is
 * installed. `DORKOS_HUB_SMOKE_BIN` replaces the command, for example
 * `node packages/cli/dist/bin/cli.js` from a checkout. Plain Node, no
 * dependencies: the image carries nothing else.
 *
 * In the image (`DORKOS_HUB_SMOKE_ISOLATE=0`) the hub runs with the image's
 * own settings: its bind address and its data folder. Anywhere else it gets a
 * throwaway home, loopback, and a free port unless `DORKOS_HUB_SMOKE_PORT`
 * names one.
 */
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ISOLATE = process.env.DORKOS_HUB_SMOKE_ISOLATE !== '0';
let CLOUD_PORT = 0;
let HUB_PORT = Number(process.env.DORKOS_HUB_SMOKE_PORT ?? 0);
const KEY = 'hub-smoke-instance-key-0123456789';
const ADDRESS_HOST = 'hub-smoke.example.invalid';
const PROOF = { header: 'x-hub-smoke-proof', secret: 'p'.repeat(48) };
const [bin, ...binArgs] = (process.env.DORKOS_HUB_SMOKE_BIN ?? 'dorkos').split(' ');

let failures = 0;
const children = [];

/** Record one check. */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

// ── The stand-in for Cloud ────────────────────────────────────────────────
const cloud = { assigned: false, confirmed: null, reads: 0, wrongKey: 0, unexpected: [] };

const cloudServer = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    cloud.wrongKey += 1;
    res.writeHead(401, { 'content-type': 'application/problem+json' });
    res.end(
      JSON.stringify({ type: 'about:blank', code: 'unauthorized', status: 401, title: 'No' })
    );
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/hubs/self/assignment') {
    cloud.reads += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        cloud.assigned
          ? {
              state: 'assigned',
              assignmentId: 'asg_smoke_1',
              assignedAt: new Date().toISOString(),
              ownerAccountId: 'acct_smoke_owner',
              issuer: 'https://accounts.example.invalid',
              address: `https://${ADDRESS_HOST}`,
              frontDoorProof: PROOF,
            }
          : { state: 'pooled', pollAfterSeconds: 1 }
      )
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/hubs/self/assignment/confirm') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      cloud.confirmed = JSON.parse(body || '{}').assignmentId ?? null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ confirmedAt: new Date().toISOString() }));
    });
    return;
  }
  // A hub calls Cloud for its assignment and nothing else.
  cloud.unexpected.push(`${req.method} ${req.url}`);
  res.writeHead(404, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: 'about:blank', code: 'not_found', status: 404, title: 'No' }));
});

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Every log file under `dir`, read whole. */
function readLogs(dir) {
  if (!existsSync(dir)) return '';
  let text = '';
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.log')) {
      text += readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8');
    }
  }
  return text;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** One GET to the hub with raw headers; resolves to its status and body. */
function get(path, headers = []) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: HUB_PORT, path, headers: headers.flat() },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.end();
  });
}

/** Wait until `test` resolves true, or fail after `ms`. */
async function waitFor(test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Start the hub with `extraEnv`; resolves to the child and its output so far. */
function startHub(extraEnv) {
  const home = ISOLATE ? mkdtempSync(join(tmpdir(), 'hub-smoke-')) : null;
  const dorkHome = home ? join(home, '.dork') : (process.env.DORK_HOME ?? join(homedir(), '.dork'));
  const out = { text: '', home, dorkHome };
  const env = {
    ...process.env,
    ...(home ? { HOME: home, DORK_HOME: dorkHome, DORKOS_HOST: '127.0.0.1' } : {}),
    DORKOS_SERVER_ROLE: 'hub',
    DORKOS_PORT: String(HUB_PORT),
    DORKOS_CLOUD_API_URL: `http://127.0.0.1:${CLOUD_PORT}`,
    ...extraEnv,
  };
  // A hub refuses to boot beside this flag, so it must be absent, not empty.
  delete env.DORKOS_ALLOW_INSECURE_BIND;
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const child = spawn(bin, binArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => (out.text += chunk));
  child.stderr.on('data', (chunk) => (out.text += chunk));
  children.push(child);
  return { child, out };
}

/** Whether the child exits within `ms`; resolves to its exit code, or null. */
function exitWithin(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  cloudServer.close();
}

// ── The run ───────────────────────────────────────────────────────────────
async function main() {
  CLOUD_PORT = await freePort();
  if (!HUB_PORT) HUB_PORT = ISOLATE ? await freePort() : 4242;
  await new Promise((r) => cloudServer.listen(CLOUD_PORT, '127.0.0.1', r));

  // 1. No key, no boot.
  {
    const { child, out } = startHub({ DORKOS_HUB_INSTANCE_KEY: undefined });
    const code = await exitWithin(child, 60_000);
    check(
      'refuses to boot without DORKOS_HUB_INSTANCE_KEY',
      code !== null && code !== 0,
      out.text.slice(-400)
    );
    check(
      'says which setting is missing, and nothing else',
      out.text.includes('DORKOS_HUB_INSTANCE_KEY') &&
        !out.text.includes('DORKOS_ALLOW_INSECURE_BIND'),
      out.text.slice(-400)
    );
    if (out.home) rmSync(out.home, { recursive: true, force: true });
  }

  // 2. Pooled.
  const { child, out } = startHub({ DORKOS_HUB_INSTANCE_KEY: KEY });
  child.once('exit', (code) => {
    if (failures === 0 && !done)
      console.log(`hub exited early with ${code}\n${out.text.slice(-2000)}`);
  });
  const up = await waitFor(
    async () => (await get('/api/health', [['host', 'probe.internal']])).status === 200,
    90_000
  );
  check('the health check answers on any Host, with no proof', up, out.text.slice(-2000));
  if (!up) return;
  // Something else on the port would answer too; the hub must be the one.
  check('the hub is the one answering', child.exitCode === null, out.text.slice(-2000));
  if (child.exitCode !== null) return;
  const pooled = await get('/api/config', [
    ['host', ADDRESS_HOST],
    [PROOF.header, PROOF.secret],
  ]);
  check(
    'everything else answers 503 while pooled',
    pooled.status === 503,
    `${pooled.status} ${pooled.text}`
  );
  check('the 503 says the hub is not serving', pooled.text.includes('HUB_NOT_SERVING'));
  check('it reads its assignment with its key', await waitFor(async () => cloud.reads > 0, 10_000));
  check('it never presents another key', cloud.wrongKey === 0);

  // 3. Assigned.
  cloud.assigned = true;
  const confirmed = await waitFor(async () => cloud.confirmed === 'asg_smoke_1', 15_000);
  check('it confirms the assignment it read', confirmed, `confirmed=${cloud.confirmed}`);
  const serving = await waitFor(
    async () =>
      (
        await get('/api/config', [
          ['host', ADDRESS_HOST],
          [PROOF.header, PROOF.secret],
        ])
      ).status !== 503,
    10_000
  );
  check('it serves once confirmed', serving);

  // 4. The front door.
  const through = await get('/api/config', [
    ['host', ADDRESS_HOST],
    [PROOF.header, PROOF.secret],
  ]);
  check(
    'a request through the front door reaches the app (and its sign-in)',
    through.status === 401 || through.status === 200,
    `${through.status} ${through.text.slice(0, 200)}`
  );
  const noProof = await get('/api/config', [['host', ADDRESS_HOST]]);
  check('no proof: 403', noProof.status === 403, `${noProof.status}`);
  const twoProofs = await get('/api/config', [
    ['host', ADDRESS_HOST],
    [PROOF.header, PROOF.secret],
    [PROOF.header, PROOF.secret],
  ]);
  check('two proofs: 403', twoProofs.status === 403, `${twoProofs.status}`);
  const wrongProof = await get('/api/config', [
    ['host', ADDRESS_HOST],
    [PROOF.header, 'q'.repeat(48)],
  ]);
  check('a wrong proof: 403', wrongProof.status === 403, `${wrongProof.status}`);
  const wrongHost = await get('/api/config', [
    ['host', 'other.example.invalid'],
    [PROOF.header, PROOF.secret],
  ]);
  check('another address: 403', wrongHost.status === 403, `${wrongHost.status}`);
  check('it presented no other key, ever', cloud.wrongKey === 0);
  check(
    'it called Cloud for nothing but its assignment',
    cloud.unexpected.length === 0,
    cloud.unexpected.join(', ')
  );
  const logged = out.text + readLogs(join(out.dorkHome, 'logs'));
  check('its logs were read', readLogs(join(out.dorkHome, 'logs')).length > 0, out.dorkHome);
  check('the proof secret is never logged', !logged.includes(PROOF.secret));
  check('the instance key is never logged', !logged.includes(KEY));

  done = true;
  child.kill('SIGTERM');
  check('it shuts down on SIGTERM', (await exitWithin(child, 20_000)) !== null);
  if (out.home) rmSync(out.home, { recursive: true, force: true });
}

let done = false;
main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(() => {
    cleanup();
    console.log(
      failures === 0 ? '\nAll hub smoke checks passed.' : `\n${failures} hub smoke check(s) failed.`
    );
    process.exit(failures === 0 ? 0 : 1);
  });
