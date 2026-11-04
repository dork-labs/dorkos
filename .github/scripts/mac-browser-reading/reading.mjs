/**
 * The Mac reading of the Agent browser's managed Chromium, against an installed
 * CLI on the test runtime: does an http:// page stay http, and what do both windows
 * really run with. Writes results.json, and exits non-zero unless every expected
 * row passed. Made-up hosts only. See .github/workflows/mac-browser-reading.yml.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  checkAgentFlags,
  checkPlainFlags,
  disabledFeatureFlags,
  EXPECTED_ROWS,
  verdict,
} from './verdict.mjs';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const OUT = env('READING_OUT');
const HOME = env('READING_HOME');
const CLI = env('READING_CLI');
const SHA = env('READING_SHA');
const HITS = env('READING_HITS');
const CALLS = path.join(OUT, 'agent-calls.jsonl');
const PORT = 4411;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT_DIR = path.join(HOME, 'agents', 'reading-demo');
const START_PAGE = 'http://127.0.0.1:4412/';
const SETTLE_MS = 12_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const rows = [];
const result = {
  sha: SHA,
  platform: process.platform,
  arch: process.arch,
  // CI's tarball plus one test-only scenario line. Fails here if that record is missing.
  bundlePatch: JSON.parse(readFileSync(path.join(OUT, 'bundle-patch.json'), 'utf8')),
  rows,
};
const save = () =>
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
const row = (id, pass, detail) => {
  rows.push({ id, ...detail, pass });
  log(pass ? 'PASS' : 'FAIL', id, JSON.stringify(detail).slice(0, 400));
  save();
};

async function api(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'content-type': 'application/json', Origin: BASE, 'X-Client-Id': 'mac-reading' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: the caller reads the status.
  }
  return { status: response.status, json, text };
}

const hits = () =>
  existsSync(HITS)
    ? readFileSync(HITS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const callsFor = (tag) =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((c) => c.tag === tag)
    : [];

/** One scripted agent turn. Returns its recorded calls, once they have all landed. */
async function turn(session, plan, expected) {
  const tag = randomUUID();
  const sent = await api('POST', `/api/sessions/${session}/messages`, {
    create: true,
    cwd: AGENT_DIR,
    content: JSON.stringify({ tag, ...plan }),
  });
  if (sent.status >= 300)
    throw new Error(`Turn refused, ${sent.status}: ${sent.text.slice(0, 200)}`);
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    const calls = callsFor(tag);
    if (calls.length >= expected) return calls;
    await sleep(300);
  }
  throw new Error(`Turn ${tag} recorded ${callsFor(tag).length} of ${expected} calls`);
}

/** The main process of the window on our profile: it names the data dir and isn't a helper. */
function browserProcess() {
  const lines = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' }).split('\n');
  const profiles = path.join(HOME, 'dork', 'browser-profiles');
  return lines
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), args: match[2] }))
    .filter((p) => p.args.includes(`--user-data-dir=${profiles}`) && !p.args.includes('--type='));
}

/** Stock Playwright's own list, from a launch of the very copy this tarball installed. */
async function stockPlaywrightList() {
  const require = createRequire(`${CLI}/`);
  const { chromium } = require('playwright-core');
  const dir = mkdtempSync(path.join(HOME, 'stock-'));
  const context = await chromium.launchPersistentContext(dir, { headless: false });
  try {
    const stock = execFileSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(`--user-data-dir=${dir}`) && !line.includes('--type='));
    if (stock.length !== 1) throw new Error(`Found ${stock.length} stock browsers`);
    const flags = disabledFeatureFlags(stock[0]);
    if (flags.length !== 1)
      throw new Error(`Stock Playwright has ${flags.length} --disable-features`);
    return flags[0];
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Wait for the agent to read the page on the host, over either scheme, or for time to run out. */
async function settle(session, host) {
  const end = Date.now() + SETTLE_MS;
  let last = null;
  while (Date.now() < end) {
    const [read] = await turn(session, {}, 1);
    last = read;
    if (read.ok && read.url?.includes(host) && /Served over/.test(read.snapshot ?? '')) return read;
    await sleep(500);
  }
  return last;
}

/** A row passes only if the page stayed http, port 80 was reached, and 443 wasn't. */
function stayedHttp(host, read, from) {
  const seen = hits()
    .slice(from)
    .filter((hit) => hit.host === host && hit.path !== '/favicon.ico');
  const on80 = seen.filter((hit) => hit.scheme === 'http').length;
  const on443 = seen.filter((hit) => hit.scheme === 'https').length;
  const pass =
    read?.ok === true &&
    read.url?.startsWith(`http://${host}/`) &&
    /Served over http\b/.test(read.snapshot ?? '') &&
    on80 > 0 &&
    on443 === 0;
  return { pass, agentReads: read?.url ?? null, code: read?.code ?? null, on80, on443 };
}

async function readHost(session, name) {
  const host = `${name}.example.com`;
  await api('POST', '/api/local-browser/disconnect');
  await sleep(1000);

  let from = hits().length;
  const opened = await api('POST', '/api/local-browser/open', {
    mode: 'new-window',
    sessionId: session,
    url: `http://${host}/first`,
  });
  const read = opened.status === 200 ? await settle(session, host) : null;
  const person = stayedHttp(host, read, from);
  row(`${name}: person opens`, opened.status === 200 && person.pass, {
    status: opened.status,
    refusal: opened.json?.code ?? null,
    ...person,
  });

  await api('POST', '/api/local-browser/disconnect');
  await sleep(1000);
  const start = await api('POST', '/api/local-browser/open', {
    mode: 'new-window',
    sessionId: session,
    url: START_PAGE,
  });
  if (start.status !== 200)
    throw new Error(`Couldn't open the start page: ${start.text.slice(0, 200)}`);
  await sleep(1500);
  from = hits().length;
  const calls = await turn(session, { navigate: `http://${host}/agent` }, 2);
  const act = calls.find((call) => call.tool === 'act');
  const agent = stayedHttp(host, await settle(session, host), from);
  row(`${name}: agent navigates`, agent.pass, { act: act?.ok ? 'ok' : act?.code, ...agent });
}

async function readFlags(session, playwrightList) {
  await api('POST', '/api/local-browser/disconnect');
  await sleep(1000);
  const opened = await api('POST', '/api/local-browser/open', {
    mode: 'new-window',
    sessionId: session,
    url: START_PAGE,
  });
  if (opened.status !== 200)
    throw new Error(`Couldn't open the agent window: ${opened.text.slice(0, 200)}`);
  await sleep(1500);
  const agent = browserProcess();
  if (agent.length !== 1) throw new Error(`Found ${agent.length} agent windows`);
  writeFileSync(path.join(OUT, 'flags-agent-window.txt'), `${agent[0].args}\n`);
  const agentCheck = checkAgentFlags(agent[0].args, playwrightList);
  row('flags: agent window', agentCheck.pass, {
    count: agentCheck.count,
    problems: agentCheck.problems,
  });

  await api('POST', '/api/local-browser/disconnect');
  await sleep(1500);
  const signIn = await api('POST', '/api/local-browser/sign-in', { url: START_PAGE });
  if (signIn.status !== 200)
    throw new Error(`Couldn't open the plain window: ${signIn.text.slice(0, 200)}`);
  await sleep(3000);
  const plain = browserProcess();
  if (plain.length !== 1) throw new Error(`Found ${plain.length} plain windows`);
  writeFileSync(path.join(OUT, 'flags-plain-window.txt'), `${plain[0].args}\n`);
  const plainCheck = checkPlainFlags(plain[0].args);
  row('flags: plain window', plainCheck.pass, {
    count: plainCheck.count,
    problems: plainCheck.problems,
  });
  process.kill(plain[0].pid, 'SIGTERM');
}

let server;
let crash = null;
try {
  const dork = path.join(HOME, 'dork');
  mkdirSync(AGENT_DIR, { recursive: true });
  mkdirSync(path.join(HOME, 'claude'), { recursive: true });
  mkdirSync(dork, { recursive: true });
  writeFileSync(
    path.join(dork, 'config.json'),
    JSON.stringify({
      telemetry: { enabled: false, userHasDecided: true },
      onboarding: {
        dismissedAt: '2026-10-01T00:00:00.000Z',
        completedAt: '2026-10-01T00:00:00.000Z',
      },
    })
  );
  const serverLog = openSync(path.join(OUT, 'server.log'), 'a');
  server = spawn(process.execPath, [path.join(CLI, 'dist', 'bin', 'cli.js'), '--no-open'], {
    stdio: ['ignore', serverLog, serverLog],
    env: {
      PATH: process.env.PATH,
      HOME,
      DORK_HOME: dork,
      CLAUDE_CONFIG_DIR: path.join(HOME, 'claude'),
      DORKOS_BOUNDARY: HOME,
      DORKOS_TEST_RUNTIME: 'true',
      DORKOS_PORT: String(PORT),
      DORKOS_HOST: '127.0.0.1',
      DORKOS_RELAY_ENABLED: 'false',
      TUNNEL_ENABLED: 'false',
      DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
      PLAYWRIGHT_BROWSERS_PATH: env('PLAYWRIGHT_BROWSERS_PATH'),
      READING_CALLS: CALLS,
    },
  });
  const end = Date.now() + 90_000;
  for (;;) {
    const up = await fetch(`${BASE}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) break;
    if (Date.now() > end) throw new Error('The server never answered /api/health');
    await sleep(1000);
  }
  const caps = (await api('GET', '/api/local-browser/capabilities')).json;
  Object.assign(result, {
    playwright: caps?.playwrightVersion,
    chromium: caps?.managedChromiumVersion,
  });
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(`This reading is for arm64 macOS, not ${process.platform} ${process.arch}`);
  if (!caps?.newWindow)
    throw new Error(`No new-window browser here: ${JSON.stringify(caps?.unavailableReasons)}`);
  const scenario = await api('POST', '/api/test/scenario', { name: 'mac-reading' });
  if (scenario.status !== 200)
    throw new Error(`No test runtime scenario: ${scenario.text.slice(0, 200)}`);

  const session = randomUUID();
  // Stock first, while no window of ours is up.
  const playwrightList = await stockPlaywrightList();
  result.stockPlaywrightDisabled = playwrightList;
  await readHost(session, 'both');
  await readHost(session, 'only-http');
  await readFlags(session, playwrightList);
} catch (error) {
  crash = String(error?.stack ?? error);
  log('CRASH', crash);
}
server?.kill('SIGTERM');
result.verdict = verdict(rows, crash);
result.expected = EXPECTED_ROWS;
save();
log('VERDICT', JSON.stringify(result.verdict));
process.exit(result.verdict.pass ? 0 : 1);
