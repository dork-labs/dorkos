import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeWorker } from './owned-worker.mjs';
import { strictProcessIdentity } from '../../profile-reservation.mjs';

test(
  'process-table failure still closes owned Node worker and retains primary observation error',
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'metadata-observer-failure-'));
    const originalPath = process.env.PATH;
    let worker;
    t.after(async () => {
      process.env.PATH = originalPath;
      if (worker) await worker.stop();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(
      join(root, 'ps'),
      '#!/bin/sh\nif [ "$1" = "-axo" ]; then echo OWNED_PROCESS_TABLE_UNAVAILABLE >&2; exit 1; fi\nexec /bin/ps "$@"\n',
      { mode: 0o700 }
    );
    worker = startNativeWorker();
    const { identity } = await worker.request({ type: 'identity' });
    assert.equal(strictProcessIdentity(identity.pid)?.birth, identity.birth);
    process.env.PATH = root + ':' + originalPath;
    let failure;
    try {
      await worker.stop();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'unavailable inventory must not return a fabricated complete cleanup');
    assert.match(failure.message, /ps -axo/);
    assert.match(failure.stderr.toString(), /OWNED_PROCESS_TABLE_UNAVAILABLE/);
    assert.equal(
      strictProcessIdentity(identity.pid),
      null,
      'graceful close still terminates the exact owned worker'
    );
  }
);

test('healthy Node-only worker cleanup retains a complete exact inventory', async (t) => {
  const worker = startNativeWorker();
  t.after(() => worker.stop());
  const { identity } = await worker.request({ type: 'identity' });
  const cleanup = await worker.stop();
  assert.equal(cleanup.allGone, true);
  assert.ok(
    cleanup.identities.some((owned) => owned.pid === identity.pid && owned.birth === identity.birth)
  );
  assert.equal(strictProcessIdentity(identity.pid), null);
});

test('owned worker does not inherit parent input-type flags', async () => {
  const url = new URL('./owned-worker.mjs', import.meta.url).href;
  const code = `const { startNativeWorker } = await import(${JSON.stringify(url)}); const worker = startNativeWorker(); try { await worker.request({ type: 'identity' }); } finally { console.log(JSON.stringify(await worker.stop())); }`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', code],
    { timeout: 5000 }
  );
  assert.equal(JSON.parse(stdout).allGone, true);
});
