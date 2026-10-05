import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';
import { startDarwinSupervisorClient } from '../runtime/darwin-supervisor-client.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
  wrongNonce = false,
  rootFailure: 'none' | 'matching' | 'reused' = 'none',
  onRootFailure: () => void = () => {}
) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-client-'));
  roots.push(root);
  const workerPath = join(root, 'worker.cjs');
  // A genuine Node/IPC/pipe fixture only; no Chromium or native cleanup claim.
  await writeFile(
    workerPath,
    `let seed; process.on('message', message => {
    if (!seed) { seed=message; process.send({kind:'ready',nonce:seed.nonce,reservationNonce:seed.reservationNonce,browserId:seed.browserId,generation:seed.generation,root:{pid:123,birth:'semantic-only'},supervisor:{pid:process.pid,birth:'semantic-only'},endpointURL:'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',proxyURL:'http://127.0.0.1:1234'}); return; }
    if (message.action.kind==='close') { process.send({kind:'closed',nonce:seed.nonce,sequence:message.sequence,returned:true},()=>process.disconnect()); }
    else { ${rootFailure !== 'none' ? `process.send({kind:'rootFailure',nonce:seed.nonce,root:{pid:123,birth:${JSON.stringify(rootFailure === 'matching' ? 'semantic-only' : 'reused-birth')}}});` : ''} process.send({kind:'reply',nonce:${wrongNonce ? "'wrong'" : 'seed.nonce'},sequence:message.sequence,value:[{tab:1,url:'about:blank'}]}); }
  });`
  );
  return startDarwinSupervisorClient(
    {
      workerPath,
      browserId: 'fixture',
      generation: 0,
      reservationNonce: randomUUID(),
      manager: { pid: process.pid, birth: 'fixture-only' },
      profileDir: root,
      origin: 'http://127.0.0.1:1234',
      artifact: { path: join(root, 'not-executed'), sha256: 'a'.repeat(64) },
      runtime: {
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: root,
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: join(root, 'not-executed-browser'),
          sha256: 'b'.repeat(64),
          revision: '1243',
          version: '153.0.8010.12',
          platform: 'darwin',
          arch: 'arm64',
        },
        identity: { mode: 'native', policyRevision: 1 },
      } as BrowserRuntimeDescriptor,
    },
    onRootFailure
  );
}
it('retains genuine supervisor originals until IPC completion and natural pipe/terminal return', async () => {
  const client = await fixture();
  try {
    expect(await client.list()).toEqual([{ tab: 1, url: 'about:blank' }]);
    expect(client.custody().pending).toBe(true);
    const closing = client.close();
    expect(client.close()).toBe(closing);
    expect(await closing).toEqual({ pending: false, uncertain: false });
    await expect(client.list()).rejects.toThrow('SUPERVISOR_STOPPED');
  } finally {
    await client.close();
  }
});
it('refuses mismatched replies without healing uncertainty when the actual worker later returns', async () => {
  const client = await fixture(true);
  try {
    await expect(client.list()).rejects.toThrow('SUPERVISOR_UNAVAILABLE');
  } finally {
    expect((await client.close()).uncertain).toBe(true);
  }
});

it.each(['matching', 'reused'] as const)(
  'accepts only the exact original root failure %s over genuine IPC',
  async (mode) => {
    let calls = 0;
    const client = await fixture(false, mode, () => {
      calls++;
    });
    try {
      await client.list().catch(() => {});
      expect(calls).toBe(mode === 'matching' ? 1 : 0);
      expect(client.custody().uncertain).toBe(true);
      await expect(client.list()).rejects.toThrow('SUPERVISOR_STOPPED');
      expect((await client.close()).uncertain).toBe(true);
    } finally {
      await client.close();
    }
  }
);
