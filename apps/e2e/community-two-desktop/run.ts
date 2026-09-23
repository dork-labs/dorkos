import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { REPO_ROOT, readRunConfig } from './config.js';
import type { Desktop } from './desktop.js';
import { Infrastructure } from './infra.js';
import { runJourney } from './journey.js';

/**
 * Two-Desktop Community acceptance run: the entry point.
 *
 * Refuses to start unless `DORKOS_TWO_DESKTOP_ACCEPTANCE=1`. Then, in order:
 * optionally builds the packaged app and the Community server (`--build`),
 * brings up Postgres and two Community servers, drives the journey in
 * `journey.ts`, and tears down exactly what it created. Evidence (step log,
 * receipt, screenshots, per-app network and console trails) lands in a fresh
 * `run-<timestamp>/` folder under the output root; server logs and blobs go
 * in its `private/` subfolder.
 *
 * Usage (see README.md):
 *
 *   DORKOS_TWO_DESKTOP_ACCEPTANCE=1 pnpm --filter @dorkos/e2e community-two-desktop -- --build
 *
 * @module community-two-desktop/run
 */

const config = readRunConfig(process.env, process.argv.slice(2));
const runRoot = path.join(config.outputRoot, `run-${Date.now()}`);
const shots = path.join(runRoot, 'screenshots');
mkdirSync(path.join(runRoot, 'private'), { recursive: true, mode: 0o700 });
mkdirSync(shots, { recursive: true, mode: 0o700 });
const homeRoot = path.join(config.homeRoot, `dorkos-two-desktop-homes-${Date.now()}`);

function log(line: string) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(path.join(runRoot, 'steps.log'), text + '\n');
}

function build() {
  const run = (command: string, args: string[]) => {
    log(`build: ${command} ${args.join(' ')}`);
    execFileSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  };
  run('pnpm', [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@dorkos/desktop...',
    '--filter=@dorkos/community...',
  ]);
  // `run pack`: a bare `pnpm pack` makes an npm tarball instead.
  run('pnpm', ['--filter', '@dorkos/desktop', 'run', 'pack']);
  // Packaging rebuilt the native addons for Electron; put them back for system
  // Node so the rest of the workspace (and this run's tooling) keeps working.
  run('pnpm', ['rebuild', 'better-sqlite3', 'node-pty']);
}

const steps: Array<Record<string, unknown>> = [];
const findings: Array<Record<string, unknown>> = [];
const desktops: Desktop[] = [];
const launched: ElectronApplication[] = [];
const browserPages: Record<string, Page> = {};
const receipt: Record<string, unknown> = { startedAt: new Date().toISOString(), runRoot };
let browser: Browser | undefined;
const infra = new Infrastructure(runRoot, config.postgresContainer, log);

async function shot(page: Page, name: string) {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  return path.relative(runRoot, file);
}

async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  log(`STEP ${name} …`);
  try {
    const evidence = await work();
    steps.push({ name, ok: true, ms: Date.now() - started, evidence: evidence ?? null });
    log(`PASS ${name} (${Date.now() - started}ms)`);
    return evidence;
  } catch (error) {
    const err = error as Error;
    steps.push({ name, ok: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    log(`FAIL ${name}: ${err?.message ?? err}`);
    throw error;
  }
}

async function main() {
  try {
    if (config.build) build();
    if (!existsSync(config.executablePath))
      throw new Error(`No packaged app at ${config.executablePath}. Run with --build first.`);
    receipt.commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    await infra.startPostgres();
    const proof = await infra.startCommunity('proof', {
      // One active agent per member, so step 20 can prove the limit is enforced.
      COMMUNITY_AGENTS_PER_OWNER: '1',
    });
    const isolation = await infra.startCommunity('isolation');
    browser = await chromium.launch({
      ...(config.browserChannel ? { channel: config.browserChannel } : {}),
      headless: true,
      // The runner owns Ctrl-C: Playwright's own handler would kill everything and exit mid-cleanup.
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    await runJourney({
      browser,
      launch: {
        executablePath: config.executablePath,
        homeRoot,
        runRoot,
        launched,
        onLaunched: ownSignals,
      },
      infra,
      proof,
      isolation,
      step,
      shot,
      findings,
      desktops,
      receipt,
      browserPages,
    });
    const productBugs = findings.filter((f) => f.kind === 'product-bug' && !f.pass);
    receipt.outcome = productBugs.length
      ? 'FAIL-PRODUCT-CONTRACT'
      : findings.every((f) => f.pass)
        ? 'PASS'
        : 'PASS-WITH-FINDINGS';
    log(`ALL STEPS RAN; outcome ${String(receipt.outcome)}; findings: ${JSON.stringify(findings)}`);
    if (productBugs.length) process.exitCode = 1;
  } catch (error) {
    receipt.outcome = 'FAIL';
    receipt.error = String((error as Error)?.stack ?? error);
    for (const desktop of desktops) {
      try {
        await shot(desktop.page, `FAIL-${desktop.name}`);
        log(`FAIL url ${desktop.name}: ${desktop.page.url()}`);
        writeFileSync(
          path.join(runRoot, `FAIL-${desktop.name}-aria.yml`),
          await desktop.page.locator('body').ariaSnapshot()
        );
      } catch (shotError) {
        log(`fail-shot error: ${(shotError as Error).message}`);
      }
    }
    // An app whose launch failed partway never became a Desktop; photograph its window too.
    for (const [index, app] of launched.entries()) {
      if (desktops.some((desktop) => desktop.app === app)) continue;
      try {
        await shot(
          app.windows()[0] ?? (await app.firstWindow({ timeout: 5000 })),
          `FAIL-launch-${index}`
        );
      } catch (shotError) {
        log(`fail-shot error: ${(shotError as Error).message}`);
      }
    }
    for (const [name, page] of Object.entries(browserPages)) {
      try {
        await shot(page, `FAIL-browser-${name}`);
        log(`FAIL url browser ${name}: ${page.url()}`);
      } catch (shotError) {
        log(`fail-shot error: ${(shotError as Error).message}`);
      }
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

let cleaning: Promise<void> | undefined;
let interrupted: NodeJS.Signals | null = null;
/**
 * Close every app, stop the servers, remove this run's Postgres (or drop only
 * its databases), delete the temporary homes and write the receipt. Runs once,
 * whether the journey ended or the run was interrupted.
 */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    receipt.steps = steps;
    receipt.findings = findings;
    receipt.finishedAt = new Date().toISOString();
    // Every app this run started, including one whose launch failed partway.
    for (const app of [...launched].reverse()) await app.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    try {
      receipt.cleanup = await infra.teardown();
    } catch (cleanupError) {
      receipt.cleanup = `teardown failed: ${(cleanupError as Error).message}`;
      process.exitCode = 1;
    }
    if (!config.keepHomes) rmSync(homeRoot, { recursive: true, force: true });
    // Closing the apps makes the journey fail as it unwinds; the signal is the real reason.
    if (interrupted) receipt.outcome = 'INTERRUPTED';
    writeFileSync(path.join(runRoot, 'receipt.json'), JSON.stringify(receipt, null, 2));
    log(`receipt: ${path.join(runRoot, 'receipt.json')}`);
    for (const line of [receipt.cleanup].flat()) log(`cleanup: ${String(line)}`);
  })();
  return cleaning;
}

// Ctrl-C or a polite kill still cleans up: the same teardown, then exit 130.
// (SIGKILL cannot be caught; the README says what a later run sweeps then.)
function onSignal(signal: NodeJS.Signals) {
  // A second Ctrl-C abandons cleanup: the person asked twice, so stop now.
  if (interrupted) process.exit(130);
  log(`${signal}: interrupted, cleaning up`);
  interrupted = signal;
  receipt.interruptedBy = signal;
  void cleanup().finally(() => process.exit(130));
}
/*
 * Why stripping foreign listeners is safe: the run starts under tsx, whose
 * child process relays signals from its parent through a handler it hides
 * (added with prependListener, and left out of a patched listeners() and
 * listenerCount()). That handler never shows up here, so it is never removed,
 * and the tsx parent never escalates to SIGKILL. If this runner moves off tsx,
 * revisit this.
 */
/**
 * Make this runner's handler the only SIGINT/SIGTERM listener. Playwright adds
 * its own when it launches Electron; that one closes everything and exits at
 * once, before our teardown has dropped databases or removed containers.
 */
function ownSignals() {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal))
      if (listener !== onSignal) process.off(signal, listener);
    if (!process.listeners(signal).includes(onSignal)) process.on(signal, onSignal);
  }
}
ownSignals();

await main();
