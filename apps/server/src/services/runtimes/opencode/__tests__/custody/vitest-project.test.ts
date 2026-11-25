import { inject, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { validRunDescriptor } from './metadata.js';
import { connectPosixWorker } from './posix-endpoint.js';
import { acquireWorkerCustody } from './worker.js';
import type {} from './global-setup.js';

it('provides only cloneable custody metadata to the actual server project worker', async () => {
  const provided = inject('openCodeCustody');
  expect(provided).toEqual(structuredClone(provided));
  if (process.platform === 'win32') {
    expect(provided).toEqual({ kind: 'unavailable', reason: 'windows-acl-unverified' });
  } else {
    expect(provided.kind).toBe('available');
    if (provided.kind !== 'available') throw new Error('Expected server-project custody metadata');
    expect(Object.keys(provided).sort()).toEqual(['inbox', 'kind', 'run']);
    expect(Object.keys(provided.run).sort()).toEqual([
      'capability',
      'generation',
      'runId',
      'version',
    ]);
    expect(validRunDescriptor(provided.run)).toBe(true);
    expect(isAbsolute(provided.inbox)).toBe(true);
    expect((await stat(provided.inbox)).mode & 0o077).toBe(0);
  }
  const connect = vi.fn();
  await expect(
    acquireWorkerCustody({
      admitted: false,
      provided,
      connect,
      deadline: null,
      signal: new AbortController().signal,
    })
  ).rejects.toThrow(/gate/);
  expect(connect).not.toHaveBeenCalled();
});

const canOpenScope =
  process.platform === 'linux' ||
  (process.platform === 'darwin' &&
    (process.env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_DIR !== undefined ||
      process.env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_MANIFEST_SHA256 !== undefined));

it.runIf(canOpenScope)(
  'releases a disconnected worker scope so the server project can open it again',
  { timeout: 30_000 },
  async ({ signal }) => {
    const provided = inject('openCodeCustody');
    const scopeId = randomBytes(16).toString('hex');
    const deadline = Date.now() + 15_000;
    const acquire = () =>
      acquireWorkerCustody({
        admitted: true,
        provided,
        scopeId,
        signal,
        deadline,
        async connect(reply, owner) {
          if (reply.transport !== 'posix') throw new Error('Expected a POSIX custody socket');
          const { close } = await connectPosixWorker(reply, owner);
          return { close, socket: join(reply.directory, `${reply.endpointId}.sock`) };
        },
      });

    async function reacquire() {
      for (;;) {
        try {
          return await acquire();
        } catch (error) {
          // The main keeps the name busy until it has joined the disconnected guardian.
          if (
            !(error instanceof Error) ||
            error.message !== 'OpenCode custody request refused (busy)' ||
            Date.now() >= deadline
          )
            throw error;
        }
      }
    }

    const first = await acquire();
    try {
      expect((await stat(first.channel.socket)).isSocket()).toBe(true);
      // Only close the channel. Cancelling the request here would also release the scope.
      first.channel.close();
      const second = await reacquire();
      try {
        expect(second.channel.socket).not.toBe(first.channel.socket);
        expect((await stat(second.channel.socket)).isSocket()).toBe(true);
        await expect(stat(first.channel.socket)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  }
);
