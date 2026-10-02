import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDurabilityGates } from '../durability-gates.mjs';
import { probeBrowserRace } from '../durability-process-probes.mjs';
import { startFixture } from '../fixture.mjs';
import { validateGateReceipt } from '../contracts.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
test(
  'actual Chromium durable stores, clean return, independent work and process exclusion have observed controls',
  { timeout: 120_000 },
  async (t) => {
    // This enters the same runner used for evidence, including actual failed implementations.
    const root = await mkdtemp(join(tmpdir(), 'durability-gates-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const receipts = await runDurabilityGates({
      repoRoot,
      profilesDir: join(root, 'profiles'),
      artifactDir: join(root, 'artifacts'),
    });
    assert.equal(receipts.length, 4);
    for (const receipt of receipts) {
      validateGateReceipt(receipt);
      assert.equal(receipt.status, 'pass', receipt.gateId);
      assert.equal(receipt.baseline.status, 'pass', receipt.gateId);
      assert.equal(receipt.negativeControls[0].outcome, 'detected', receipt.gateId);
      const publicReceipt = JSON.parse(
        await readFile(join(root, 'artifacts', `${receipt.gateId}.json`), 'utf8')
      );
      assert.equal(publicReceipt.runtime.executablePath, '[local-only]');
      assert.equal(publicReceipt.gateId, receipt.gateId);
    }
    assert.deepEqual(
      receipts.map((r) => r.sampleCount),
      [3, 1, 200, 5]
    );
    assert.deepEqual(
      receipts.map((receipt) => receipt.negativeControls[0].sampleCount),
      [1, 1, 200, 2]
    );
  }
);

test('missing Chromium emits four unverified receipts and exits without starting workers', async (t) => {
  // Fresh child avoids cached Playwright executable resolution and exercises the real CLI failure path.
  const root = await mkdtemp(join(tmpdir(), 'durability-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactDir = join(root, 'artifacts');
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        join(repoRoot, 'scripts/browser-control-prototype/durability-gates.mjs'),
        repoRoot,
        join(root, 'profiles'),
        artifactDir,
      ],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, 'missing-browser') },
        timeout: 5000,
      }
    ),
    (error) => error.code === 1 && !error.killed
  );
  for (const gateId of ['durability', 'clean-return', 'unattended', 'profile-exclusion']) {
    const receipt = JSON.parse(await readFile(join(artifactDir, `${gateId}.json`), 'utf8'));
    validateGateReceipt(receipt);
    assert.equal(receipt.status, 'unverified');
    assert.equal(receipt.sampleCount, 0);
    assert.equal(receipt.runtime, null);
    assert.equal(receipt.negativeControls[0].outcome, 'unverified');
  }
});

test('infrastructure failures have zero observed samples and cannot invent crash outcomes', async (t) => {
  // Throw before subject creation in every probe: nothing can become a successful observation.
  const root = await mkdtemp(join(tmpdir(), 'durability-infrastructure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailable = async () => {
    throw Error('FIXTURE_INFRASTRUCTURE_UNAVAILABLE');
  };
  const probeOverrides = Object.fromEntries(
    [
      'probePersistence',
      'probeClean',
      'probeUnattended',
      'probeExclusion',
      'probeCrash',
      'probeBrowserRace',
    ].map((name) => [name, unavailable])
  );
  const receipts = await runDurabilityGates({
    repoRoot,
    profilesDir: join(root, 'profiles'),
    artifactDir: join(root, 'artifacts'),
    probeOverrides,
  });
  assert.equal(receipts.length, 4);
  for (const receipt of receipts) {
    assert.equal(receipt.status, 'unverified');
    assert.equal(receipt.sampleCount, 0);
    assert.equal(receipt.baseline.sampleCount, 0);
    assert.equal(receipt.negativeControls[0].sampleCount, 0);
    assert.equal(receipt.negativeControls[0].outcome, 'unverified');
  }
  const crash = receipts.find((receipt) => receipt.gateId === 'profile-exclusion');
  assert.match(crash.limitations[0], /Crash probe unverified/);
  assert.doesNotMatch(crash.limitations[0], /exited with manager pipe|survived manager death/);
});

test('CLI alias invocation executes and produces exactly four unavailable-runtime receipts', async (t) => {
  // Symlink resolution reproduces the macOS /var versus /private/var same-file entry mismatch.
  const root = await mkdtemp(join(tmpdir(), 'durability-cli-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(repoRoot, 'scripts/browser-control-prototype'), join(root, 'alias'));
  const artifactDir = join(root, 'artifacts');
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [join(root, 'alias/durability-gates.mjs'), repoRoot, join(root, 'profiles'), artifactDir],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, 'missing-browser') },
        timeout: 5000,
      }
    ),
    (error) => error.code === 1 && !error.killed
  );
  for (const gateId of ['durability', 'clean-return', 'unattended', 'profile-exclusion']) {
    const receipt = JSON.parse(await readFile(join(artifactDir, `${gateId}.json`), 'utf8'));
    assert.equal(receipt.status, 'unverified');
    assert.equal(receipt.sampleCount, 0);
  }
});

test(
  'unrelated first manager startup failure cannot certify profile exclusion',
  { timeout: 20_000 },
  async (t) => {
    // The faulty contender retries normally: validating only that later refusal would falsely pass.
    const root = await mkdtemp(join(tmpdir(), 'durability-startup-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const source = await readFile(new URL('../reservation-contender.mjs', import.meta.url), 'utf8');
    const needle = "} else if (message.type === 'open') {";
    assert.equal(source.split(needle).length, 2);
    const mutant =
      'let opens = 0;\n' +
      source
        .replace("'./manager.mjs'", JSON.stringify(new URL('../manager.mjs', import.meta.url).href))
        .replace("'./runtime.mjs'", JSON.stringify(new URL('../runtime.mjs', import.meta.url).href))
        .replace(
          needle,
          needle +
            "if (++opens === 1) { const error = Error('unrelated'); error.code = 'UNRELATED_STARTUP'; throw error; }"
        );
    const secondContenderPath = join(root, 'startup-mutant.mjs');
    await writeFile(secondContenderPath, mutant, { mode: 0o600 });
    await assert.rejects(
      probeBrowserRace({
        repoRoot,
        profilesDir: join(root, 'profiles'),
        fixture,
        secondContenderPath,
      }),
      /first startup refusal must prove profile exclusion/
    );
  }
);

test('negative controls reject unrelated setup assertions, forged codes and wrong observed causes', async (t) => {
  const { NegativeObservation } = await import('../durability/negative-observation.mjs');
  const faults = [
    'ephemeral-persistence',
    'seeded-clean',
    'shared-context',
    'per-process-reservation',
  ];
  for (const mode of ['assertion', 'forged', 'wrong-cause', 'matching']) {
    const root = await mkdtemp(join(tmpdir(), 'durability-cause-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const override = (fault, samples) => async (options) => {
      const negative = options.fault || options.moduleUrl;
      if (!negative) return { samples, sessionAfter: [true, true, true], survivorObserved: false };
      if (mode === 'assertion') assert.fail('UNRELATED_SETUP_ASSERTION');
      if (mode === 'forged')
        throw Object.assign(Error('unrelated'), { fault, sampleCount: samples });
      throw new NegativeObservation(mode === 'matching' ? fault : 'other-fault', samples);
    };
    const receipts = await runDurabilityGates({
      repoRoot,
      profilesDir: join(root, 'profiles'),
      artifactDir: join(root, 'artifacts'),
      probeOverrides: {
        probePersistence: override(faults[0], 3),
        probeClean: override(faults[1], 1),
        probeUnattended: override(faults[2], 200),
        probeExclusion: override(faults[3], 2),
        probeCrash: async () => ({ samples: 1, survivorObserved: false }),
        probeBrowserRace: async () => ({ samples: 2 }),
      },
    });
    for (const receipt of receipts) {
      assert.equal(
        receipt.status,
        mode === 'matching' ? 'pass' : 'unverified',
        `${mode}/${receipt.gateId}`
      );
      assert.equal(
        receipt.negativeControls[0].outcome,
        mode === 'matching' ? 'detected' : 'unverified'
      );
      assert.equal(
        receipt.negativeControls[0].sampleCount,
        mode === 'matching' ? [3, 1, 200, 2][faults.indexOf(receipt.negativeControls[0].id)] : 0
      );
    }
  }
});

test('baseline setup assertions count no observed subjects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'durability-baseline-assertion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probeOverrides = Object.fromEntries(
    [
      'probePersistence',
      'probeClean',
      'probeUnattended',
      'probeExclusion',
      'probeCrash',
      'probeBrowserRace',
    ].map((name) => [name, async () => assert.fail('UNRELATED_SETUP_ASSERTION')])
  );
  const receipts = await runDurabilityGates({
    repoRoot,
    profilesDir: join(root, 'profiles'),
    artifactDir: join(root, 'artifacts'),
    probeOverrides,
  });
  for (const receipt of receipts) {
    assert.equal(receipt.status, 'unverified');
    assert.equal(receipt.sampleCount, 0);
    assert.equal(receipt.baseline.sampleCount, 0);
    assert.equal(receipt.negativeControls[0].sampleCount, 0);
  }
});
