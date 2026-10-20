/** Installed CLI and isolated browser fixtures only. No model or personal browser data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LocalBrowserState as BrowserState } from '../../packages/shared/src/local-browser.js';
import { bounded } from './owned-chrome-cleanup.js';
import * as installedUi from './installed-cli-ui.js';
import { runProofCommand } from './proof-command.js';
import { ProofSourceCustody, readPackedProof } from './source-snapshot.js';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, realpath, access, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type * as Playwright from '../../packages/cli/node_modules/playwright-core/index.js';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = process.cwd();
const common = (
  await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })
).stdout.trim();
const lanePath =
  // eslint-disable-next-line no-restricted-syntax
  process.env.LOCAL_BROWSER_LANE_FILE ??
  path.join(path.dirname(path.dirname(common)), '.workspace', 'shared-local-heavy-producer.lock');
const lane = JSON.parse(await readFile(lanePath, 'utf8')) as { scope: string; root: string };
assert(
  lane.scope.includes('cli-proof') && lane.root === root,
  'Run this proof through run-in-lane.py with a cli-proof scope'
);
const output = path.join(root, '.dork/local-browser/cli-proof', String(Date.now()));
const artifacts = path.join(output, 'artifacts');
const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-cli-installed-proof-')));
const installation = path.join(sandbox, 'installation');
const fixtureCwd = path.join(sandbox, 'fixture');
const dataDirectory = path.join(sandbox, 'data');
const browserCache = path.join(sandbox, 'browser-cache');
const fixtureHome = path.join(sandbox, 'os-home');
for (const directory of [
  artifacts,
  installation,
  fixtureCwd,
  dataDirectory,
  browserCache,
  fixtureHome,
])
  await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(installation, 'package.json'),
  JSON.stringify({ name: 'isolated-dorkos-browser-proof', private: true, version: '1.0.0' })
);
await writeFile(
  path.join(fixtureCwd, 'index.html'),
  '<h1>Isolated local browser package proof</h1>'
);

const receipt: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  root,
  output,
  sandbox,
  paidInference: false,
  personalBrowserTouched: false,
  checks: {},
  status: 'running',
};
const checks = receipt.checks as Record<string, unknown>;
// eslint-disable-next-line no-restricted-syntax
const childEnv = installedUi.installedCliEnvironment(process.env, {
  dataDirectory,
  fixtureHome,
  browserCache,
});
const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let cli: ChildProcess | undefined;
let fixture: Server | undefined;
let uiProof: ReturnType<typeof installedUi.installedCliUi> | undefined;
let base: string | undefined;
let sourceCustody: ProofSourceCustody | undefined;

async function command(
  name: string,
  args: string[],
  cwd: string,
  logName: string
): Promise<string> {
  return runProofCommand({ name, args, cwd, log: path.join(output, logName), env: childEnv });
}
async function port(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = 6000 + Math.floor(Math.random() * 1000);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return candidate;
    } catch {
      /* Try another unused proof port. */
    }
  }
  throw new Error('Could not reserve a 6xxx fixture port');
}
interface ProofCapabilities {
  embedded: boolean;
  defaultMode: string;
  playwrightVersion: string;
}
async function http<T = Record<string, unknown>>(
  route: string,
  body?: unknown,
  timeout = 210_000
): Promise<{ status: number; json: T }> {
  assert(base);
  const response = await fetch(new URL(route, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, json: (await response.json()) as T };
}
async function ok(route: string, body?: unknown): Promise<BrowserState> {
  const result = await http<BrowserState>(route, body);
  assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.json)}`);
  return result.json;
}
async function title(expected: string): Promise<BrowserState> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await ok('/api/local-browser/state');
    if (state.tabs.some((tab: { title: string }) => tab.title === expected)) return state;
    await nap(100);
  }
  throw new Error(`Live installed browser did not show ${expected}`);
}
async function stopCli(): Promise<void> {
  if (!cli || cli.exitCode !== null || cli.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => cli!.once('exit', () => resolve()));
  cli.kill('SIGTERM');
  await Promise.race([exited, nap(15_000)]);
  if (cli.exitCode === null && cli.signalCode === null) {
    cli.kill('SIGKILL');
    await bounded(exited, 5_000, 'Installed CLI kill closure');
  }
}

try {
  sourceCustody = await ProofSourceCustody.start(root, output, childEnv);
  receipt.sourceCustody = sourceCustody.evidence;
  await command('pnpm', ['--filter', 'dorkos', 'build'], root, 'build.log');
  await sourceCustody.checkpoint('after-build');
  const packOutput = await command(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts],
    path.join(root, 'packages/cli'),
    'pack.log'
  );
  await sourceCustody.checkpoint('after-pack');
  const packed = await readPackedProof(packOutput, artifacts, sourceCustody.evidence.fingerprint);
  receipt.package = packed.metadata;
  await command(
    'npm',
    [
      'install',
      '--global=false',
      '--prefix',
      installation,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      packed.tarball,
    ],
    installation,
    'install.log'
  );
  const installedPackage = path.join(installation, 'node_modules/dorkos');
  const installedRequire = createRequire(path.join(installedPackage, 'package.json'));
  const playwrightPath = await realpath(installedRequire.resolve('playwright-core/package.json'));
  receipt.resolvedPlaywrightPath = playwrightPath;
  assert(
    playwrightPath.startsWith(installation + path.sep),
    'Playwright must resolve inside isolated install'
  );
  assert(
    !playwrightPath.startsWith(path.join(root, 'node_modules')),
    'Workspace resolution is not installed proof'
  );
  const playwrightPackage = JSON.parse(await readFile(playwrightPath, 'utf8'));
  assert.equal(playwrightPackage.version, '1.63.0');
  const descriptors = JSON.parse(
    await readFile(path.join(path.dirname(playwrightPath), 'browsers.json'), 'utf8')
  );
  const chromium = descriptors.browsers.find(
    (entry: { name: string }) => entry.name === 'chromium'
  );
  assert(
    chromium && chromium.browserVersion.startsWith('153.'),
    'Installed browser descriptor must pin Chromium 153'
  );
  checks.installedLibrary = { version: playwrightPackage.version, path: playwrightPath, chromium };
  const installedMetadata = JSON.parse(
    await readFile(path.join(installedPackage, 'package.json'), 'utf8')
  );
  assert.equal(installedMetadata.version, packed.metadata.version);
  assert.equal(installedMetadata.dependencies['playwright-core'], '1.63.0');
  // Installed Playwright must see the same isolated cache as the installed CLI child.
  // eslint-disable-next-line no-restricted-syntax
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  const playwright = installedRequire('playwright-core') as typeof Playwright;

  checks.cacheInitiallyEmpty = await installedUi.qualifyFreshInstalledCache(
    browserCache,
    playwright.chromium.executablePath()
  );
  let persistedRequests = 0;
  const cookieRequests: { phase: string; cookiePresent: boolean; receivedAt: string }[] = [];
  checks.fixtureCookieRequests = cookieRequests;
  const fixturePort = await port();
  const versionProbePath = `/seed?versionProbe=${randomUUID()}`;
  const versionRequests: { requestPath: string; userAgent: string }[] = [];
  fixture = createServer((request, response) => {
    if (request.url === versionProbePath)
      versionRequests.push({
        requestPath: request.url,
        userAgent: request.headers['user-agent'] ?? '',
      });
    response.setHeader('Content-Type', 'text/html');
    if (request.url?.startsWith('/seed'))
      response.setHeader('Set-Cookie', 'dorkos_proof=owned; Max-Age=3600; Path=/; SameSite=Lax');
    const persisted = request.headers.cookie?.includes('dorkos_proof=owned') ?? false;
    const phase = request.url?.split('?')[0] ?? '/';
    if (['/seed', '/cookie-check', '/resume'].includes(phase))
      cookieRequests.push({
        phase,
        cookiePresent: persisted,
        receivedAt: new Date().toISOString(),
      });
    if (request.url?.startsWith('/resume') && persisted) persistedRequests++;
    const heading =
      request.url?.startsWith('/cookie-check') && persisted
        ? 'Owned sign-in verified before close'
        : request.url?.startsWith('/resume') && persisted
          ? 'Persistent sign-in verified'
          : 'Installed browser fixture';
    response.end(
      `<title>${heading}</title><h1>${heading}</h1><label>Name<input aria-label="Name"></label><button onclick="document.title='Fixture clicked'">Click fixture</button>`
    );
  });
  await new Promise<void>((resolve) => fixture!.listen(fixturePort, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  const versionProbeUrl = `${fixtureUrl}${versionProbePath}`;
  const cliPort = await port();
  base = `http://127.0.0.1:${cliPort}`;
  receipt.serverLaunches = [];
  const startInstalled = async (suffix: string) => {
    const serverLog = createWriteStream(path.join(output, `installed-server-${suffix}.log`));
    cli = spawn(
      process.execPath,
      [
        path.join(installedPackage, 'dist/bin/cli.js'),
        '--no-open',
        '--no-tasks',
        '--port',
        String(cliPort),
        '--dir',
        fixtureCwd,
        '--boundary',
        fixtureCwd,
      ],
      { cwd: fixtureCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    cli.stdout!.pipe(serverLog, { end: false });
    cli.stderr!.pipe(serverLog, { end: false });
    cli.once('exit', () => serverLog.end());
    (receipt.serverLaunches as unknown[]).push({
      pid: cli.pid,
      port: cliPort,
      fixturePort,
      dataDirectory,
      fixtureCwd,
      testRuntime: true,
    });
    let caps: ProofCapabilities | undefined;
    let lastStartupResult: unknown;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (cli.exitCode !== null || cli.signalCode !== null)
        throw new Error(`Installed CLI exited ${cli.exitCode}; inspect installed-server.log`);
      try {
        const result = await http<ProofCapabilities>('/api/local-browser/capabilities');
        lastStartupResult = result;
        if (result.status === 200) {
          caps = result.json;
          break;
        }
      } catch (error) {
        lastStartupResult = error instanceof Error ? error.message : String(error);
      }
      await nap(200);
    }
    assert(
      caps,
      `Installed CLI did not expose browser capabilities: ${JSON.stringify(lastStartupResult)}`
    );
    const listening = await exec(
      'lsof',
      ['-nP', '-a', '-p', String(cli.pid), `-iTCP:${cliPort}`, '-sTCP:LISTEN', '-t'],
      { timeout: 2_000 }
    );
    assert(
      listening.stdout.trim().split(/\s+/).includes(String(cli.pid)),
      'The installed CLI must physically own its allocated HTTP port'
    );
    return caps;
  };
  uiProof = installedUi.installedCliUi({
    driver: installedUi.proofUiDriver,
    env: childEnv,
    sandbox,
    dataDirectory,
    base,
    output,
    receipt,
  });
  const caps = await installedUi.provePreparationFailureThenStart(
    uiProof,
    childEnv,
    startInstalled,
    stopCli,
    checks
  );
  assert.equal(caps.embedded, false);
  assert.equal(caps.defaultMode, 'new-window');
  assert.equal(caps.playwrightVersion, '1.63.0');
  checks.webCapabilities = caps;
  const embedded = await http('/api/local-browser/open', { mode: 'embedded' });
  assert.equal(embedded.status, 409);
  assert.equal(embedded.json.code, 'unsupported');
  checks.honestEmbeddedRefusal = embedded;
  checks.installedUi = await uiProof.run();

  const open = await ok('/api/local-browser/open', {
    mode: 'new-window',
    sessionId: 'installed-fixture-chat',
    url: versionProbeUrl,
  });
  assert.equal(open.mode, 'new-window');
  assert.equal(open.status, 'connected');
  assert.equal(open.tabs.find((tab) => tab.id === open.selectedTabId)?.url, versionProbeUrl);
  const freshWindow = await title('Installed browser fixture');
  assert.equal(freshWindow.mode, 'new-window');
  assert.equal(
    freshWindow.tabs.find((tab) => tab.id === freshWindow.selectedTabId)?.url,
    versionProbeUrl
  );
  const versionRequest = versionRequests[0];
  assert(versionRequest, 'The new managed window did not request its unique version probe');
  const actualVersion = /\bChrome\/(153\.\d+\.\d+\.\d+)\b/.exec(versionRequest.userAgent)?.[1];
  assert(actualVersion, `Expected actual Chrome/153 request: ${versionRequest.userAgent}`);
  checks.managedBrowserVersion = { versionProbeUrl, versionRequest, browserVersion: actualVersion };
  await access(playwright.chromium.executablePath());
  checks.automaticFirstAcquisition = installedUi.firstUseAcquisitionMetadata(
    playwrightPath,
    checks.installedUi
  );
  await ok('/api/local-browser/pause', {});
  assert.equal((await ok('/api/local-browser/state')).paused, true);
  await ok('/api/local-browser/navigate', { url: `${fixtureUrl}/seed?human=1` });
  await ok('/api/local-browser/navigate', { url: `${fixtureUrl}/cookie-check` });
  await title('Owned sign-in verified before close');
  await ok('/api/local-browser/resume', {});
  assert.equal((await ok('/api/local-browser/state')).paused, false);
  await ok('/api/local-browser/disconnect', {});
  await stopCli();
  // Browser preparation must reuse its cache even when installer network requests cannot succeed.
  Object.assign(childEnv, {
    HTTPS_PROXY: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
  });
  await startInstalled('cached');
  await ok('/api/local-browser/open', { mode: 'new-window', url: `${fixtureUrl}/resume` });
  await title('Persistent sign-in verified');
  assert.equal(persistedRequests, 1);
  checks.visibleWindowPersistentReopen = {
    persistedRequests,
    pauseResume: true,
    humanNavigationWhilePaused: true,
    cachedAfterServerRestartWithInstallerProxyUnavailable: true,
  };
  await ok('/api/local-browser/disconnect', {});

  receipt.remainingProofGaps = installedUi.installedCliProofGaps;
  receipt.status = 'passed-bounded-cli-proof';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try {
    if (base && cli?.exitCode === null && cli.signalCode === null)
      await http('/api/local-browser/disconnect', {}, 5_000);
  } catch {
    /* Continue exact owned resource closure. */
  }
  if (uiProof)
    await uiProof.close().catch((error: unknown) => {
      receipt.uiCleanupError = String(error);
      receipt.status = 'failed';
      process.exitCode = 1;
    });
  await stopCli().catch((error: unknown) => {
    receipt.serverCloseError = String(error);
    receipt.status = 'failed';
    process.exitCode = 1;
  });
  fixture?.closeAllConnections();
  if (fixture)
    await bounded(
      new Promise<void>((resolve) => fixture!.close(() => resolve())),
      2_000,
      'Owned fixture close'
    ).catch((error: unknown) => {
      receipt.fixtureCloseError = String(error);
      receipt.status = 'failed';
      process.exitCode = 1;
    });
  await nap(500);
  const processList = (await exec('ps', ['-axo', 'pid=,command='])).stdout;
  const remaining = processList
    .split('\n')
    .filter(
      (line) => (line.includes(output) || line.includes(sandbox)) && !line.includes('ps -axo')
    );
  checks.physicalClosure = {
    cliExited: !cli || cli.exitCode !== null || cli.signalCode !== null,
    remainingOwnedProcesses: remaining,
  };
  if (remaining.length) {
    receipt.status = 'failed';
    receipt.cleanupError = 'Owned fixture processes remain';
    process.exitCode = 1;
  }
  await sourceCustody?.finish(receipt);
  if (!remaining.length && receipt.status === 'passed-bounded-cli-proof') {
    await rm(sandbox, { recursive: true, force: true });
    checks.temporaryInstallationRemoved = true;
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(
    path.join(root, '.dork/local-browser/cli-proof/latest.json'),
    JSON.stringify({ output, status: receipt.status }, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      output,
      status: receipt.status,
      checks: Object.keys(checks),
      remainingProofGaps: receipt.remainingProofGaps,
      error: receipt.error,
    })
  );
}
