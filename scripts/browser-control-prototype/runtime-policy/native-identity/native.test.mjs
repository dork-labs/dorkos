import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeProbe } from './run-native.mjs';
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

test(
  'native cross-site target and same-endpoint controls distinguish hint omission from instrumentation failure',
  { timeout: 40_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-availability-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const actual = await runNativeProbe({ repoRoot, privateDir: join(root, 'delegated') });
    assert.equal(actual.nativeCoherenceStatus, 'pass', actual.failure);
    assert.equal(actual.status, 'unverified');
    assert.equal(actual.subjectCount, 6);
    assert.equal(actual.installedSourceUnchanged, true);
    assert.equal(actual.cleanup.allGone, true);
    assert.equal(actual.observations.oopifTargets.length, 1);
    assert.equal(actual.observations.oopifTargets[0].url, actual.observations.frameUrl);
    assert.match(actual.observations.oopifTargets[0].url, /^https:\/\/native-b\.test:\d+\/frame$/);
    for (const type of ['dedicated', 'shared', 'service']) {
      assert.equal(actual.workerHttpHints[type].status, 'unverified');
      assert.deepEqual(actual.workerHttpHints[type].emittedHintNames, []);
      const page = actual.workerEndpointPageControls[type];
      assert.equal(page.observed, true);
      assert.ok(page.headers['sec-ch-ua-full-version-list']);
      assert.equal(page.path, '/fetch-' + type);
    }
    const mutation = await runNativeProbe({
      repoRoot,
      privateDir: join(root, 'no-delegation'),
      delegateHints: false,
    });
    assert.equal(mutation.status, 'unverified');
    assert.match(mutation.failure, /NATIVE_HIGH_HINT_NOT_EMITTED:\/frame-negotiated/);
    assert.equal(mutation.subjectCount, 6);
    assert.deepEqual(mutation.observations.frame, mutation.observations.main);
    const frameRequest = mutation.requests.find((request) => request.path === '/frame-negotiated');
    assert.equal(frameRequest.headers['sec-ch-ua-full-version-list'], undefined);
    assert.ok(frameRequest.headers['sec-ch-ua']);
    assert.equal(mutation.cleanup.allGone, true);
  }
);
