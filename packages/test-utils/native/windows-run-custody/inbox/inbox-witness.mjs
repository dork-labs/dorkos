/**
 * Explicit Windows fixture for the source-built, in-process directory helper.
 * From this directory with the matching Node headers and node.lib already available:
 *   node-gyp rebuild --nodedir <local-node-development-directory>
 *   node inbox-witness.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32', 'This fixture requires an actual Windows runner');
const execute = promisify(execFile);
const native = createRequire(import.meta.url)('./build/Release/custody_inbox.node');
const ownerEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => /^(systemroot|windir|temp|tmp)$/i.test(name))
);

async function inspectAcl(directory, record) {
  const shell = join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const script = fileURLToPath(new URL('./inspect-inbox-acl.ps1', import.meta.url));
  const observation = execute(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, directory, record],
    { windowsHide: true, timeout: 15_000, env: ownerEnv }
  );
  observation.child.stdin.end();
  const { stdout } = await observation;
  assert.equal(stdout.trim(), 'private directory and record ACLs observed');
}

async function worker(directory, expectedId) {
  const lease = native.open(directory);
  try {
    native.verify(lease, directory);
    assert.equal(native.identity(lease).toString('hex'), expectedId);
    await writeFile(join(directory, 'request.json'), '{"kind":"fixture"}', { flag: 'wx' });
  } finally {
    native.close(lease);
  }
}

async function witness() {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'custody-inbox-witness-'));
  const name = () => join(parent, 'dorkos-custody-' + randomBytes(16).toString('hex'));
  const directory = name();
  const lease = native.create(directory);
  const record = join(directory, 'request.json');
  try {
    native.verify(lease, directory);
    const id = native.identity(lease);
    assert.equal(id.length, 24);
    await execute(
      process.execPath,
      [fileURLToPath(import.meta.url), '--worker', directory, id.toString('hex')],
      {
        env: ownerEnv,
        timeout: 15_000,
        windowsHide: true,
      }
    );
    assert.equal(await readFile(record, 'utf8'), '{"kind":"fixture"}');
    await inspectAcl(directory, record);
    assert.throws(() => native.removeEmpty(lease), { code: 'DORKOS_PRIVATE_INBOX' });
    native.verify(lease, directory);
    const next = name();
    const successor = native.create(next);
    try {
      assert.notDeepEqual(native.identity(successor), id);
      assert.throws(() => native.verify(lease, next), { code: 'DORKOS_PRIVATE_INBOX' });
      native.verify(successor, next);
    } finally {
      native.removeEmpty(successor);
    }
    await assert.rejects(lstat(next), { code: 'ENOENT' });
  } finally {
    try {
      await unlink(record).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      native.removeEmpty(lease);
    } finally {
      native.close(lease);
    }
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    await rmdir(parent);
  }
  process.stdout.write(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      directory: 'removed',
      workerIdentityMatched: true,
      inheritedRecordAcl: true,
    }) + '\n'
  );
}

if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4]);
else await witness();
