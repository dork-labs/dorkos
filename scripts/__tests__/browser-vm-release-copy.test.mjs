import { productionBrowserVMModules } from '../browser-vm-production-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  access,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  copyBrowserVMRelease,
  clearBrowserVMModules,
  verifyBrowserVMRelease,
  copyBrowserVMModules,
} from '../browser-vm-release-copy.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const raw = await mkdtemp(join(tmpdir(), 'vm-package-'));
  t.after(() => rm(raw, { recursive: true, force: true }));
  const root = await realpath(raw),
    output = join(root, 'out');
  await mkdir(output);
  await mkdir(join(root, 'scripts'));
  return { root, output };
}
async function selected(f, edit = () => {}) {
  const directory = 'release-assets/browser-vm/' + 'a'.repeat(64),
    source = join(f.root, directory);
  await mkdir(source, { recursive: true });
  const names = [
    'qemu-system-aarch64',
    'atomic-child.node',
    'managed-browser-catalogue.dylib',
    'kernel.Image',
    'root-init.cpio',
    'root.raw',
    'blank-profile.raw',
  ];
  const bytes = new Map(
    names.map((n) => [
      n,
      Buffer.from(n.endsWith('.mjs') ? 'export const testBytes=true;\n' : 'fixture ' + n),
    ])
  );
  edit(bytes);
  const files = [];
  for (const [name, body] of bytes) {
    await writeFile(join(source, name), body);
    files.push({ name, bytes: body.length, sha256: sha(body) });
  }
  const anchor = Buffer.from('export const installedPublisherAnchor=null;\n');
  await mkdir(join(f.root, 'apps/server/src/services/browser/runtime'), { recursive: true });
  await writeFile(
    join(f.root, 'apps/server/src/services/browser/runtime/installed-publisher-anchor.mjs'),
    anchor
  );
  const manifest = Buffer.from(
    JSON.stringify({
      v: 1,
      stage: 'PUBLISHER_INSTALLED_RELEASE',
      platform: 'darwin-arm64',
      anchorSHA256: sha(anchor),
      files,
    })
  );
  await writeFile(join(source, 'PACKAGE-FILES.json'), manifest);
  await writeFile(
    join(f.root, 'scripts/browser-vm-release.json'),
    JSON.stringify({ v: 1, release: { directory, manifestSHA256: sha(manifest) } })
  );
  return { source, bytes };
}
test('empty catalogue leaves VM unavailable and removes only stale build output', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.output, 'browser/vm'), { recursive: true });
  await writeFile(join(f.output, 'browser/vm/stale'), 'stale');
  await writeFile(join(f.output, 'other'), 'preserve');
  await writeFile(join(f.root, 'scripts/browser-vm-release.json'), ' {"v":1,"release":null}\n');
  assert.deepEqual(await copyBrowserVMRelease(f.root, f.output), { available: false });
  await assert.rejects(access(join(f.output, 'browser/vm')));
  assert.equal(await readFile(join(f.output, 'other'), 'utf8'), 'preserve');
});
test('copies exactly selected assets and no second runtime graph', async (t) => {
  const f = await fixture(t),
    s = await selected(f);
  await writeFile(join(s.source, 'ignored-developer.c'), 'never ship');
  await writeFile(join(s.source, 'prebuilt-release.mjs'), 'never duplicate WeakMaps');
  assert.equal((await copyBrowserVMRelease(f.root, f.output)).available, true);
  for (const [name, bytes] of s.bytes)
    assert.deepEqual(await readFile(join(f.output, 'browser/vm', name)), bytes);
  await assert.rejects(access(join(f.output, 'browser/vm/ignored-developer.c')));
  await assert.rejects(access(join(f.output, 'browser/vm/prebuilt-release.mjs')));
});
test('rejects original changed bytes without publishing final directory', async (t) => {
  const f = await fixture(t),
    s = await selected(f);
  await writeFile(join(s.source, 'root.raw'), 'changed');
  await assert.rejects(copyBrowserVMRelease(f.root, f.output), /INPUT|CHANGED/);
  await assert.rejects(access(join(f.output, 'browser/vm')));
});
test('rejects symlink source and different compiled anchor before publication', async (t) => {
  for (const kind of ['symlink', 'anchor']) {
    const f = await fixture(t),
      s = await selected(f);
    if (kind === 'symlink') {
      await rm(join(s.source, 'root.raw'));
      await symlink(join(s.source, 'blank-profile.raw'), join(s.source, 'root.raw'));
    } else
      await writeFile(
        join(f.root, 'apps/server/src/services/browser/runtime/installed-publisher-anchor.mjs'),
        'different compiled trust'
      );
    await assert.rejects(copyBrowserVMRelease(f.root, f.output));
    await assert.rejects(access(join(f.output, 'browser/vm')));
  }
});

test('null selection and module cleanup refuse symlink parents without deleting outside sentinels', async (t) => {
  for (const kind of ['assets', 'modules']) {
    const f = await fixture(t),
      outside = join(f.root, 'outside');
    await mkdir(outside);
    if (kind === 'assets') {
      await mkdir(join(outside, 'vm'));
      await writeFile(join(outside, 'vm/sentinel'), 'keep');
      await symlink(outside, join(f.output, 'browser'));
      await writeFile(join(f.root, 'scripts/browser-vm-release.json'), ' {"v":1,"release":null}');
      await assert.rejects(copyBrowserVMRelease(f.root, f.output), /ALIAS/);
      assert.equal(await readFile(join(outside, 'vm/sentinel'), 'utf8'), 'keep');
    } else {
      await mkdir(join(outside, 'browser'));
      await writeFile(join(outside, 'browser/sentinel.mjs'), 'keep');
      await symlink(outside, join(f.output, 'services'));
      await assert.rejects(clearBrowserVMModules(f.output), /ALIAS/);
      assert.equal(await readFile(join(outside, 'browser/sentinel.mjs'), 'utf8'), 'keep');
    }
  }
});
test('pre-signer and post-signer verification require exact selected asset bytes', async (t) => {
  const f = await fixture(t);
  await selected(f);
  await copyBrowserVMRelease(f.root, f.output);
  const directory = join(f.output, 'browser/vm');
  assert.equal((await verifyBrowserVMRelease(f.root, directory)).available, true);
  await chmod(join(directory, 'qemu-system-aarch64'), 0o600);
  await writeFile(join(directory, 'qemu-system-aarch64'), 'resigned changed bytes', {
    mode: 0o600,
  });
  await assert.rejects(verifyBrowserVMRelease(f.root, directory), /INPUT|CHANGED/);
});

test('server copies only fixed same-relative production graph, never developer module neighbors', async (t) => {
  const f = await fixture(t);
  for (const relative of productionBrowserVMModules) {
    const source = join(f.root, relative);
    await mkdir(source.slice(0, source.lastIndexOf('/')), { recursive: true });
    await writeFile(source, 'export const original=true;\n');
  }
  const extra = join(f.root, 'apps/server/src/services/browser/runtime/developer-compiler.mjs');
  await writeFile(extra, 'throw new Error("must never ship")');
  assert.deepEqual(await copyBrowserVMModules(f.root, f.output), { modules: 36 });
  for (const relative of productionBrowserVMModules)
    assert.equal(
      await readFile(join(f.output, relative.slice('apps/server/src/'.length)), 'utf8'),
      'export const original=true;\n'
    );
  await assert.rejects(access(join(f.output, 'services/browser/runtime/developer-compiler.mjs')));
});
test('server closed module copy rejects source symlink without copying its foreign bytes', async (t) => {
  const f = await fixture(t),
    first = productionBrowserVMModules[0],
    source = join(f.root, first);
  await mkdir(source.slice(0, source.lastIndexOf('/')), { recursive: true });
  await writeFile(join(f.root, 'foreign'), 'foreign');
  await symlink(join(f.root, 'foreign'), source);
  await assert.rejects(copyBrowserVMModules(f.root, f.output), /FILE|CHANGED/);
  await assert.rejects(access(join(f.output, first.slice('apps/server/src/'.length))));
  assert.equal(await readFile(join(f.root, 'foreign'), 'utf8'), 'foreign');
});
