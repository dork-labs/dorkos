import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCustody, recheckCustody } from '../custody.mjs';
import { PINS } from '../policy.mjs';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'darwin-custody-doubles-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const assets = {};
  for (const name of ['guardian', 'fixture-a', 'fixture-b']) {
    const bytes = Buffer.from('DUMMY NOT EXECUTABLE ' + name);
    await writeFile(join(root, name), bytes, { mode: 0o700 });
    assets[name] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return {
    version: 1,
    root,
    plan: PINS.plan,
    sourceDigest: 'a'.repeat(64),
    compiler: '/fixture/compiler',
    sdk: '/fixture/sdk',
    architecture: 'arm64',
    assets,
  };
}
test('private copied dummy bytes verify and retain exact unchanged path identities', async (t) => {
  const manifest = await fixture(t);
  const custody = await verifyCustody(manifest);
  assert.equal(await recheckCustody(custody), true);
  assert.equal(custody.binding.length, 4);
  assert.ok(Object.isFrozen(custody.binding));
  for (const tuple of custody.binding) assert.match(tuple, /^[0-9]+(:[0-9]+){6}$/);
  assert.equal(
    custody.binding[2].split(':')[1],
    custody.files['fixture-a'].identity.ino.toString()
  );
});
test('same-byte path replacement cannot reuse an earlier custody certificate', async (t) => {
  const manifest = await fixture(t);
  const custody = await verifyCustody(manifest);
  const path = join(manifest.root, 'fixture-a');
  await rename(path, path + '-original');
  await writeFile(path, 'DUMMY NOT EXECUTABLE fixture-a', { mode: 0o700 });
  await assert.rejects(recheckCustody(custody), /CUSTODY_CHANGED/);
});
test('changed hash, symlink and writable asset refuse before any transport acquisition', async (t) => {
  const manifest = await fixture(t);
  manifest.assets.guardian.sha256 = 'b'.repeat(64);
  await assert.rejects(verifyCustody(manifest), /CUSTODY_CHANGED/);
  const other = await fixture(t);
  await chmod(join(other.root, 'guardian'), 0o777);
  await assert.rejects(verifyCustody(other), /CUSTODY_ASSET/);
  const linked = await fixture(t);
  await rename(join(linked.root, 'guardian'), join(linked.root, 'original'));
  await symlink(join(linked.root, 'original'), join(linked.root, 'guardian'));
  await assert.rejects(verifyCustody(linked), /CUSTODY_ASSET/);
});
