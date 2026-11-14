/** DOR-4273: run only in sealed Linux Docker; importing this file never launches a browser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, release, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sampleInterval } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ProofSourceCustody } from './source-snapshot.js';
import {
  MEMORY_FIXTURE_ARTICLES,
  MEMORY_FIXTURE_HTML as FIXTURE,
  MEMORY_FIXTURE_SNAPSHOT_BUDGET_BYTES,
  assertMemoryFixtureSnapshot,
} from './chat-memory-fixture.js';
import {
  assertDocker,
  ownedProcesses,
  parseOptions,
  processTable,
  sampleMemory,
  summarize,
  type MemoryOptions,
  type MemorySample,
  type ProcessIdentity,
} from './chat-memory-support.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
// eslint-disable-next-line no-restricted-syntax -- Standalone Docker runner: graphical host facts and Git subprocess environment, never app settings.
const environment = process.env;

async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Loaded only after Docker/display/cgroup/source preflight; never downloads a browser. */
async function loadRuntime() {
  const [{ LocalBrowserService }, backend, { installedChromePath }, { boundedPageSnapshot }] =
    await Promise.all([
      import('../../apps/server/src/services/session/local-browser/service.js'),
      import('../../apps/server/src/services/session/local-browser/playwright-backend.js'),
      import('../../apps/server/src/services/session/local-browser/connection/chrome-installation.js'),
      import('../../apps/server/src/services/session/local-browser/observation-limits.js'),
    ]);
  backend.assertLocalPlaywrightVersion();
  const requireServer = createRequire(path.join(ROOT, 'apps/server/package.json'));
  const core = requireServer('playwright-core') as { chromium: { executablePath(): string } };
  const executable = installedChromePath() ?? core.chromium.executablePath();
  await access(executable); // productionBackend cannot enter its download fallback after this.
  return {
    LocalBrowserService,
    backend: backend.productionBackend,
    boundedPageSnapshot,
    receipt: {
      libraryVersion: backend.LOCAL_PLAYWRIGHT_VERSION,
      managedVersion: backend.LOCAL_MANAGED_CHROMIUM_VERSION,
      executable,
      executableSha256: await sha256(executable),
      headed: true,
    },
  };
}
type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

async function phase(
  name: string,
  roots: ProcessIdentity[],
  count: number,
  options: MemoryOptions,
  exercise?: () => Promise<unknown>
) {
  const started = performance.now();
  const samples: MemorySample[] = [];
  for (let index = 0; index < count; index++) {
    // Resource sampling needs an explicit cadence; this is not a browser readiness wait.
    await sampleInterval(options.intervalMs);
    await exercise?.();
    samples.push(await sampleMemory(roots, started));
  }
  const metricNames = [
    'browserRssBytes',
    'browserPssBytes',
    'browserPrivateBytes',
    'nodeRssBytes',
    'containerBytes',
  ] as const;
  return {
    name,
    samples,
    summary: Object.fromEntries(
      metricNames.map((key) => [key, summarize(samples.map((s) => s[key]))])
    ),
  };
}

async function awaitClosed(before: ProcessIdentity[]) {
  const known = new Set(before.map((row) => `${row.pid}:${row.birth}`));
  const end = performance.now() + 10_000;
  while (true) {
    const remaining = (await processTable()).filter(
      (row) => row.state !== 'Z' && !known.has(`${row.pid}:${row.birth}`)
    );
    if (!remaining.length) return;
    assert(
      performance.now() < end,
      'Browser cleanup left live processes; preserve the container evidence.'
    );
    await sampleInterval(200);
  }
}

async function measureCase(
  runtime: Runtime,
  options: MemoryOptions,
  chats: number,
  repeat: number
) {
  const data = await mkdtemp(path.join(tmpdir(), 'dorkos-chat-memory-'));
  const before = await processTable();
  let context: Awaited<ReturnType<Runtime['backend']['launch']>> | undefined;
  let launches = 0;
  const service = new runtime.LocalBrowserService(
    data,
    undefined,
    {
      ...runtime.backend,
      launch: async (...args) => {
        launches++;
        context = await runtime.backend.launch(...args);
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (/^chat-\d+\.memory\.example$/.test(url.hostname) && url.pathname === '/')
            await route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
          else await route.abort();
        });
        return context;
      },
      connect: async () => {
        throw Error('This measurement never attaches to an existing browser.');
      },
    },
    undefined,
    () => ({ platform: 'linux', display: environment.DISPLAY }),
    () => [],
    () => []
  );
  service.useAgentIdentityLookup(async (id) => `agent-${id}`);
  service.windowNames.use(async () => 'Kestrel');
  const ids = Array.from({ length: chats }, (_, index) => `memory-chat-${index + 1}`);
  const phases: Awaited<ReturnType<typeof phase>>[] = [];
  const receipt = {
    chats,
    repeat,
    status: 'running',
    launches: 0,
    physicalPages: 0,
    fixtureSnapshotBytes: [] as number[],
    browserVersion: null as string | null,
    viewport: null as { width: number; height: number; dpr: number } | null,
    phases,
    cleanup: 'pending',
    error: null as string | null,
    cleanupError: null as string | null,
  };
  const save = () =>
    writeFile(
      path.join(options.output, `case-${repeat}-${chats}.json`),
      JSON.stringify(receipt, null, 2) + '\n'
    );
  const record = async (...args: Parameters<typeof phase>) => {
    phases.push(await phase(...args));
    await save();
  };
  await save();
  let clean = false;
  let failure: unknown;
  try {
    await record('before-browser', [], 5, options);
    for (const [index, sessionId] of ids.entries()) {
      const state = await service.open({
        mode: 'new-window',
        sessionId,
        url: `https://chat-${index + 1}.memory.example/`,
      });
      assert.equal(state.status, 'connected');
      assert.equal(state.tabs.length, 1);
    }
    assert.equal(launches, 1, 'All chats must share one physical browser window.');
    assert(context);
    assert.equal(context.pages().length, chats, 'Exactly one physical page per chat.');
    for (const page of context.pages()) {
      await page.waitForLoadState('load');
      assert.equal(await page.locator('article').count(), MEMORY_FIXTURE_ARTICLES);
      // A real rendered snapshot is the regression test: HTML bytes cannot prove ARIA size.
      receipt.fixtureSnapshotBytes.push(
        assertMemoryFixtureSnapshot(await runtime.boundedPageSnapshot(page, 750))
      );
    }
    const protocol = await context.newCDPSession(context.pages()[0]!);
    const version = await protocol.send('Browser.getVersion');
    receipt.browserVersion = version.product;
    receipt.viewport = await context.pages()[0]!.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    receipt.launches = launches;
    receipt.physicalPages = context.pages().length;
    await protocol.detach();
    const known = new Set(before.map((row) => `${row.pid}:${row.birth}`));
    const roots = (await processTable()).filter(
      (row) => row.parent === process.pid && !known.has(`${row.pid}:${row.birth}`)
    );
    assert(roots.length > 0, 'No owned browser process found.');
    ownedProcesses(roots, await processTable());
    // Keep warm-up raw evidence, but do not mix it into the idle/reading summaries.
    await record('warm-up', roots, 3, options);
    await record('idle', roots, options.samples, options);
    await record('reading', roots, options.samples, options, () =>
      Promise.all(
        ids.map(async (id) => {
          const observation = await service.observe(id);
          assertMemoryFixtureSnapshot(observation.snapshot);
        })
      )
    );
    await service.disconnect();
    await awaitClosed(before);
    clean = true;
    await record('after-close', [], 5, options);
    const all = phases.flatMap((entry) => entry.samples);
    assert.equal(
      all.at(-1)!.oomKills,
      all[0]!.oomKills,
      'Container OOM invalidates the experiment.'
    );
    receipt.status = 'measured';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.message : 'Case failed.';
    failure = error;
  } finally {
    try {
      if (!clean) {
        await service.disconnect();
        await awaitClosed(before);
        clean = true;
      }
      if (clean) await rm(data, { recursive: true });
    } catch (error) {
      receipt.status = 'failed';
      receipt.cleanupError = error instanceof Error ? error.message : 'Cleanup failed.';
      failure ??= error;
    } finally {
      receipt.cleanup = clean ? 'closed' : 'failed';
      await save().catch((error: unknown) => {
        failure ??= error;
      });
    }
  }
  if (failure !== undefined) throw failure;
  return receipt;
}

/** Produces raw and summarized evidence, never an automatic cap approval. */
export async function main(args: string[]) {
  const options = parseOptions(args);
  assertDocker(process.platform, existsSync('/.dockerenv'), environment.DISPLAY);
  const initial = await sampleMemory([], performance.now()); // Preflight before any launch.
  assert.equal(initial.oomKills, 0, 'Start a fresh container without earlier OOM kills.');
  const limit = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim();
  assert(
    /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)) && Number(limit) > 0,
    'Set an explicit Docker memory limit.'
  );
  await mkdir(options.output); // Refuse reuse/overwrite of an older run.
  const source = await ProofSourceCustody.start(ROOT, options.output, environment);
  assert.equal(source.evidence.head, options.revision, 'Run the exact committed candidate.');
  const runtime = await loadRuntime();
  const report = {
    schemaVersion: 1,
    status: 'running',
    capDecision: 'pending',
    options,
    fixture: {
      kind: `${MEMORY_FIXTURE_ARTICLES} synthetic articles per distinct HTTPS origin`,
      sha256: createHash('sha256').update(FIXTURE).digest('hex'),
      snapshotBudgetBytes: MEMORY_FIXTURE_SNAPSHOT_BUDGET_BYTES,
    },
    source: source.evidence,
    runtime: runtime.receipt,
    host: {
      platform: process.platform,
      arch: arch(),
      release: release(),
      cpus: cpus().length,
      node: process.version,
      memoryLimitBytes: Number(limit),
      cpuMax: (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(),
      swapMax: (await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(),
    },
    cases: [] as Awaited<ReturnType<typeof measureCase>>[],
    error: null as string | null,
  };
  const save = () =>
    writeFile(path.join(options.output, 'memory.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  try {
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      const order = repeat % 2 === 0 ? [...options.chats].reverse() : options.chats;
      for (const chats of order) {
        report.cases.push(await measureCase(runtime, options, chats, repeat));
        await source.checkpoint(`repeat-${repeat}-chats-${chats}`);
        await save();
      }
    }
    report.status = 'measured';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : 'Measurement failed.';
    process.exitCode = 1;
  } finally {
    await source.finish(report);
    await save();
  }
  console.log(
    JSON.stringify({
      status: report.status,
      report: path.join(options.output, 'memory.json'),
      capDecision: 'pending',
    })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Memory measurement refused.');
    process.exitCode = 1;
  });
