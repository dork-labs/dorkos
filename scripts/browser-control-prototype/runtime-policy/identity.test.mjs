import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePatchedPackage } from './package-copy.mjs';
import { runIdentityProbe } from './run-identity.mjs';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceDir = join(
  repoRoot,
  'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core'
);

test('exact private copy changes only its bundle and refuses changed version/source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-patch-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await readFile(join(sourceDir, 'lib/coreBundle.js'));
  const stage = join(root, 'copy');
  const result = await stagePatchedPackage({ sourceDir, stagingDir: stage });
  assert.notEqual(result.beforeSha256, result.afterSha256);
  assert.deepEqual(await readFile(join(sourceDir, 'lib/coreBundle.js')), original);
  assert.notEqual(
    (await stat(join(stage, 'lib/coreBundle.js'))).ino,
    (await stat(join(sourceDir, 'lib/coreBundle.js'))).ino
  );
  await assert.rejects(
    stagePatchedPackage({ sourceDir: stage, stagingDir: join(root, 'second') }),
    /SOURCE_HASH_MISMATCH/
  );
  const invalid = join(root, 'invalid');
  await mkdir(invalid);
  await writeFile(join(invalid, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  await assert.rejects(
    stagePatchedPackage({ sourceDir: invalid, stagingDir: join(root, 'third') }),
    /PACKAGE_VERSION_MISMATCH/
  );
});

test(
  'actual pinned narrow Page candidate passes but rejects mismatching worker identity',
  { timeout: 40_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'metadata-identity-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const receipt = await runIdentityProbe({ repoRoot, privateRoot: join(root, 'private') });
    assert.equal(receipt.smallestIdentityStatus, 'pass', receipt.failure);
    assert.equal(receipt.uaOnlyMismatchDetected, true);
    assert.equal(receipt.invalidDescriptorRefused, true);
    assert.equal(receipt.heldInstallation.requestsBeforeRelease.length, 0);
    assert.equal(receipt.status, 'fail');
    assert.match(receipt.failure, /shared legacy identity mismatch/);
    assert.deepEqual(receipt.workerComparisons, {
      dedicated: { legacyMatches: true, metadataMatches: true },
      shared: { legacyMatches: false, metadataMatches: true },
      service: { legacyMatches: false, metadataMatches: true },
    });
    assert.equal(receipt.observedTargetCount, 13);
    assert.equal(receipt.cleanup.allGone, true);
    assert.ok(receipt.cleanup.identities.length >= 2);
    assert.deepEqual(receipt.launch.sandboxFlags, []);
    assert.deepEqual(receipt.launch.spkiFlags, [
      '--ignore-certificate-errors-spki-list=' + receipt.tls.spkiHash,
    ]);
    const service = receipt.requests.find((request) => request.path === '/identity-worker-service');
    assert.match(service.headers['user-agent'], /HeadlessChrome\/153/);
  }
);
