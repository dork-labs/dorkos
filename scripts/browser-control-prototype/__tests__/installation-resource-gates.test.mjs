import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { loadPlaywright } from '../runtime.mjs';
import { startFixture } from '../fixture.mjs';
import { missingInstallControl } from '../resources/installation-probe.mjs';
import {
  orphanControls,
  crashRecovery,
  recentWriteCrash,
} from '../resources/crash-resource-probe.mjs';
import {
  cpuSeconds,
  processTable,
  ownedTree,
  distribution,
  distinctOwned,
} from '../resources/resource-process.mjs';
import { processIdentity } from '../profile-reservation.mjs';
import { descendantObserverControl } from '../resources/resource-manager-crash.mjs';
import { deriveCandidateCaps } from '../resources/resource-sampling.mjs';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Metrics must preserve actual units and refuse malformed or missing subjects rather than fabricate zeroes.
test('CPU forms, measured distributions and owned subject identity are exact', () => {
  assert.equal(cpuSeconds('01:02.50'), 62.5);
  assert.equal(cpuSeconds('1-01:02:03'), 90123);
  assert.throws(() => cpuSeconds('unknown'), /UNAVAILABLE/);
  assert.throws(() => distribution('absent', 'MiB', []), /UNAVAILABLE/);
  assert.deepEqual(distribution('measured', 'count', [4, 1, 2, 3]), {
    name: 'measured',
    unit: 'count',
    sampleCount: 4,
    min: 1,
    max: 4,
    p50: 2,
    p95: 4,
  });
  const root = processIdentity(process.pid);
  const rows = ownedTree(root, processTable());
  assert.ok(rows.some((row) => row.pid === root.pid && row.birth === root.birth));
  assert.throws(() => ownedTree({ ...root, birth: 'wrong-birth' }), /OWNED_ROOT_UNAVAILABLE/);
});

// The missing-cache action is a real fresh-process attempt; no installer is armed by this test.
test(
  'absent Chromium refuses an action without silently filling a fresh private cache',
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-missing-install-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const result = await missingInstallControl({
      repoRoot,
      cacheDir: join(root, 'cache'),
      profilesDir: join(root, 'subjects'),
      fixtureOrigin: fixture.url,
    });
    assert.equal(result.samples, 1);
  }
);

// A live owned subject and incorrect birth expose false-negative observers and unsafe PID-only shutdown.
test(
  'orphan positive control detects a live child and wrong birth cannot kill it',
  { timeout: 10_000 },
  async () => {
    assert.equal((await orphanControls()).samples, 3);
  }
);

// Real Page.crash, exact root SIGKILL and manager SIGKILL have distinct observed outcomes.
test(
  'renderer browser and manager deaths preserve committed stores and report lost actions',
  { timeout: 40_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-crash-resource-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const runtime = await loadPlaywright({ repoRoot });
    const result = await crashRecovery({
      repoRoot,
      runtime,
      profilesDir: join(root, 'subjects'),
      fixture,
    });
    assert.equal(result.samples, 3);
    assert.equal(result.lostActions, 2);
    assert.ok(result.rendererDeaths > 0);
    assert.ok(result.shutdownSubjects > 2);
    assert.equal(result.shutdownSubjects, distinctOwned(result.shutdownInventory).length);
    assert.ok(result.managerDeathSubjects > 1);
    assert.ok(result.managerRecoverySubjects > 1);
    assert.ok(result.cacheRequests >= 1);
  }
);

// Recent writes are an observation with explicit lost-store counts, never silently folded into committed recovery.
test(
  'recent acknowledged writes retain every observed store outcome after abrupt browser death',
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-recent-write-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const runtime = await loadPlaywright({ repoRoot });
    const result = await recentWriteCrash({
      runtime,
      profilesDir: join(root, 'subjects'),
      fixture,
    });
    assert.equal(result.samples, 1);
    assert.deepEqual(Object.keys(result.survived), [
      'login',
      'localStorage',
      'indexedDB',
      'cacheStorage',
      'serviceWorker',
    ]);
    assert.ok(Object.values(result.survived).every((value) => typeof value === 'boolean'));
    assert.equal(
      result.lostStores,
      Object.values(result.survived).filter((value) => !value).length
    );
  }
);

// Without installed runtime, unavailable observations produce nonzero CLI exit and zero samples, not passing skips.
test(
  'missing runtime CLI emits exactly four explicit receipts without browser observations',
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-resource-unavailable-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const command = promisify(execFile);
    await assert.rejects(
      command(
        process.execPath,
        [
          fileURLToPath(new URL('../installation-resource-gates.mjs', import.meta.url)),
          repoRoot,
          join(root, 'private'),
          join(root, 'artifacts'),
        ],
        {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, 'empty-runtime') },
          timeout: 8000,
        }
      ),
      (error) => {
        assert.equal(error.code, 1);
        const results = JSON.parse(error.stdout);
        assert.equal(results.length, 4);
        assert.ok(
          results.every((receipt) => receipt.status === 'unverified' && receipt.sampleCount === 0)
        );
        return true;
      }
    );
    for (const gate of ['installation', 'recent-write-crash', 'crash-shutdown', 'resources']) {
      const receipt = JSON.parse(await readFile(join(root, 'artifacts', gate + '.json'), 'utf8'));
      assert.equal(receipt.runtime, null);
      assert.equal(receipt.baseline.sampleCount, 0);
    }
  }
);

// Loaded-host observations must reduce recommended additional slots, not use total hardware as spare capacity.
test('candidate caps subtract observed baseline pressure and remain within the tested envelope', () => {
  const metrics = [
    ['active-browserA-rss', 700],
    ['active-browserB-rss', 740],
    ['active-browserA-cpu', 19],
    ['active-browserB-cpu', 17],
    ['baseline-host-free', 2000],
    ['baseline-host-cpu', 90],
    ['active-node-rss', 159],
    ['active-viewer-rss', 1100],
    ['active-node-cpu', 15],
    ['active-viewer-cpu', 30],
  ].map(([name, value]) => distribution(name, name.endsWith('cpu') ? 'percent' : 'MiB', [value]));
  const loaded = deriveCandidateCaps({ measurements: metrics, cores: 14, totalMiB: 49152 });
  assert.equal(loaded.browsers, 0);
  assert.equal(loaded.viewers, 0);
  const quiet = metrics.map((metric) =>
    metric.name === 'baseline-host-free'
      ? distribution(metric.name, 'MiB', [40000])
      : metric.name === 'baseline-host-cpu'
        ? distribution(metric.name, 'percent', [10])
        : metric
  );
  assert.equal(
    deriveCandidateCaps({ measurements: quiet, cores: 14, totalMiB: 49152 }).browsers,
    2
  );
  assert.throws(
    () => deriveCandidateCaps({ measurements: [], cores: 14, totalMiB: 49152 }),
    /UNAVAILABLE/
  );
});

// Root disappearance alone cannot conceal a still-live exact descendant which was reparented.
test(
  'live reparented descendant prevents root-only orphan certification',
  { timeout: 10_000 },
  async () => {
    assert.equal((await descendantObserverControl()).samples, 1);
  }
);
