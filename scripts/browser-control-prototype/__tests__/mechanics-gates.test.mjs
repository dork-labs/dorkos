import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMechanicsGates, observe, observeNegative } from '../mechanics/mechanics-gates.mjs';
import {
  distribution,
  environment,
  assertObservation,
  withCleanup,
  assertSeparateDirectories,
} from '../mechanics/mechanics-helpers.mjs';
import {
  probeHandoffs,
  probeRevokedEpoch,
  probeQueueBound,
  probeDisconnectReset,
} from '../mechanics/mechanics-handoff.mjs';
import { probeIdentity, probeDiagnostics } from '../mechanics/mechanics-identity.mjs';
import { mutatedControl, probeRenderAck, wrongPage } from '../mechanics/mechanics-controls.mjs';
import { loadPlaywright } from '../runtime.mjs';
const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
// Statistics preserve actual sample counts and use nearest-rank p95 rather than averaging tails.
test('mechanics distributions require real observations and preserve tail samples', () => {
  const d = distribution(
    'sample',
    'ms',
    Array.from({ length: 100 }, (_, i) => i + 1)
  );
  assert.deepEqual(d, {
    name: 'sample',
    unit: 'ms',
    sampleCount: 100,
    min: 1,
    max: 100,
    p50: 50,
    p95: 95,
  });
  assert.throws(() => distribution('empty', 'ms', []));
});
// Infrastructure refusal cannot become a detected negative control.
test('mechanics observations distinguish assertion detection from unavailable infrastructure', async () => {
  assert.equal(
    (
      await observe(() => {
        throw Error('missing-runtime');
      })
    ).status,
    'unverified'
  );
  assert.equal((await observe(() => assert.fail('known-bad-subject'))).assertion, true);
});
test('mechanics runner refuses understated formal counts and writes runtime-unverified receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    repoRoot: root,
    profilesDir: join(root, 'private'),
    artifactDir: join(root, 'receipts'),
    only: ['handoff'],
  };
  await assert.rejects(runMechanicsGates({ ...options, handoffRounds: 99 }));
  await assert.rejects(runMechanicsGates({ ...options, only: ['unknown'] }));
  await assert.rejects(runMechanicsGates({ ...options, only: [] }));
  const receipts = await runMechanicsGates(options);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'unverified');
  assert.equal(receipts[0].sampleCount, 0);
  assert.equal(
    JSON.parse(await readFile(join(root, 'receipts', 'handoff.json'), 'utf8')).runtime,
    null
  );
});
// A setup assertion or changed mutant anchor cannot certify the intended fault.
test('negative controls require their exact observation failure', async () => {
  const intended = await observeNegative('revoked-epoch', () =>
    assertObservation(false, 'revoked-epoch-executed')
  );
  assert.deepEqual(intended, { id: 'revoked-epoch', outcome: 'detected', sampleCount: 1 });
  await assert.rejects(observeNegative('unknown', () => assert.fail('unrelated')));
  const fixture = {
    locator: () => ({
      boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
      textContent: async () => '0',
    }),
  };
  const unexpectedOutcome = {
    tab: { tabId: 'fake-tab', page: fixture },
    request: (action) => ({ action }),
    agent: 'fake-agent',
    human: 'fake-human',
    control: {
      takeover: () => ({ barrier: Promise.resolve() }),
      handoff: () => ({ barrier: Promise.resolve() }),
      submit: async () => ({ outcome: 'failed' }),
    },
  };
  assert.deepEqual(
    await observeNegative('revoked-epoch', () => probeRevokedEpoch(unexpectedOutcome)),
    { id: 'revoked-epoch', outcome: 'unverified', sampleCount: 0 }
  );

  const cleanupFault = await observeNegative('revoked-epoch', () =>
    withCleanup(
      () => assertObservation(false, 'revoked-epoch-executed'),
      () => {
        throw Error('cleanup failed');
      }
    )
  );
  assert.equal(cleanupFault.outcome, 'unverified');
  assert.equal(cleanupFault.sampleCount, 0);
  for (const probe of [
    () => assert.fail('unrelated-fixture-setup'),
    () =>
      mutatedControl('revoked-epoch', () => {}, { sourceText: 'export class PrototypeControl {}' }),
  ])
    assert.deepEqual(await observeNegative('revoked-epoch', probe), {
      id: 'revoked-epoch',
      outcome: 'unverified',
      sampleCount: 0,
    });
});
test('probe cleanup preserves the primary result and exposes standalone cleanup failure', async () => {
  const primary = new assert.AssertionError({
    message: 'PRIMARY_OBSERVATION',
    actual: false,
    expected: true,
  });
  const result = { samples: 3 };
  primary.result = result;
  const secondary = Error('SECONDARY_CLEANUP');
  await assert.rejects(
    withCleanup(
      () => {
        throw primary;
      },
      () => {
        throw secondary;
      }
    ),
    (error) =>
      error === primary &&
      error.result === result &&
      error.cleanupFailure &&
      error.cleanupError === secondary
  );
  await assert.rejects(
    withCleanup(
      () => ({ samples: 1 }),
      () => {
        throw secondary;
      }
    ),
    (error) => error === secondary
  );
});
test('artifact separation refuses both containment directions and realpath aliases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-separation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, 'private'),
    artifacts = join(root, 'receipts');
  await mkdir(profiles);
  await mkdir(artifacts);
  await assertSeparateDirectories(profiles, artifacts);
  for (const [a, b] of [
    [profiles, join(profiles, 'nested')],
    [join(artifacts, 'nested'), artifacts],
    [profiles, profiles],
  ])
    await assert.rejects(assertSeparateDirectories(a, b));
  const alias = join(root, 'alias');
  await symlink(profiles, alias);
  await assert.rejects(assertSeparateDirectories(profiles, join(alias, 'nested')));
});
// Smoke the actual canonical Page boundaries; formal 100-round receipts are a separate executable run.
test('real mechanics probes detect same-actor epoch, queue, wrong-page and missing-ack faults', async (t) => {
  const runtime = await loadPlaywright({ repoRoot });
  const root = await mkdtemp(join(tmpdir(), 'mechanics-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let count = 0;
  async function run(fn, controlClass) {
    const profilesDir = join(root, String(++count));
    await mkdir(profilesDir, { mode: 0o700 });
    const s = await environment({ runtime, profilesDir, controlClass });
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  }
  await run(async (s) => {
    assert.equal((await probeDisconnectReset(s)).samples, 3);
    assert.equal((await probeRevokedEpoch(s)).samples, 1);
    assert.equal((await probeQueueBound(s)).samples, 9);
    assert.equal((await probeHandoffs(s, 3)).samples, 3);
    assert.equal((await probeDiagnostics(s)).samples, 60);
    assert.equal((await probeRenderAck(s)).samples, 1);
    await assert.rejects(probeRenderAck(s, { fault: true }), assert.AssertionError);
  });
  assert.equal((await run(probeIdentity)).samples, 15);
  await assert.rejects(
    run(async (s) => {
      const open = s.open.bind(s),
        capture = s.manager.capture.bind(s.manager);
      let second,
        opened = 0;
      s.open = async (...args) => {
        const page = await open(...args);
        if (++opened === 2) {
          second = page;
          await page.evaluate(() => {
            const context = globalThis.document.querySelector('#screen').getContext('2d');
            const draw = context.drawImage.bind(context);
            context.drawImage = (...args) => {
              if (!globalThis.freezeNewFrames) draw(...args);
            };
          });
        }
        return page;
      };
      s.manager.capture = async (...args) => {
        const frame = await capture(...args);
        if (second && (await s.tab.page.locator('#revision').textContent()) === '1')
          await second.evaluate(() => (globalThis.freezeNewFrames = true));
        return frame;
      };
      return probeIdentity(s);
    }),
    (error) => error.failureCode === 'wrong-page-pixels'
  );
  await assert.rejects(
    mutatedControl('revoked-epoch', (Class) => run(probeRevokedEpoch, Class)),
    assert.AssertionError
  );
  await assert.rejects(
    mutatedControl('unbounded-queue', (Class) => run(probeQueueBound, Class)),
    assert.AssertionError
  );
  await assert.rejects(
    run((s) => wrongPage(s, () => probeIdentity(s))),
    assert.AssertionError
  );
});
