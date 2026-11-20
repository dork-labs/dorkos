import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCustodySetup } from './global-setup.js';
import { openOwnedInbox } from './inbox.js';
import { decodeReply, encodeMetadata } from './metadata.js';
import type { GenerationEndpoint, OpenCustodyEndpoint, ProvidedCustody } from './run-main.js';
import { acquireWorkerCustody, WorkerCleanupError } from './worker.js';

type Project = Parameters<ReturnType<typeof createCustodySetup>>[0];

function projectFixture() {
  let state: ProvidedCustody | undefined;
  let rerun: Parameters<Project['onTestsRerun']>[0] | undefined;
  const project = {
    provide: (_key: string, provided: ProvidedCustody) => {
      state = provided;
    },
    onTestsRerun: (callback: Parameters<Project['onTestsRerun']>[0]) => {
      rerun = callback;
    },
  } as Project;
  return {
    project,
    provided: () => {
      if (!state || state.kind !== 'available') throw new Error('Missing private fixture inbox');
      return state;
    },
    rerun: () => rerun!([{ project } as Parameters<NonNullable<typeof rerun>>[0][number]]),
  };
}

async function fixture(run: (parent: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), 'dorkos-run-main-test-'));
  try {
    await run(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(process.platform === 'win32')('main-side custody file composition', () => {
  it('replaces the actual ready file with a terminal reply if the scope ends before authentication', async () => {
    await fixture(async (parent) => {
      const lifecycle = projectFixture();
      const scope = deferred();
      const connected = deferred();
      const closeMain = vi.fn();
      const join = vi.fn(async () => 'closed' as const);
      const teardown = await createCustodySetup(
        async () => ({
          connection: { endpointId: '42'.repeat(16), token: '24'.repeat(32) },
          closeMain,
          join,
          scopeEnded: scope.promise,
          scopeConnected: connected.promise,
        }),
        parent
      )(lifecycle.project);
      try {
        const provided = lifecycle.provided();
        const inbox = await openOwnedInbox(provided.inbox);
        const signal = new AbortController().signal;
        const request = {
          kind: 'acquire' as const,
          requestId: '11'.repeat(16),
          scopeId: '12'.repeat(16),
          deadline: null,
        };
        await inbox.write(
          'request',
          request.requestId,
          encodeMetadata(provided.run, request),
          signal
        );
        const read = async () => {
          const bytes = await inbox.readReply(request.requestId);
          return bytes && decodeReply(provided.run, request, bytes);
        };
        await vi.waitFor(async () => expect((await read())?.kind).toBe('ready'));
        scope.resolve();
        await vi.waitFor(() => expect(join).toHaveBeenCalledOnce());
        expect(await read()).toMatchObject({ kind: 'refused', reason: 'unavailable' });
        expect(closeMain).toHaveBeenCalledOnce();
      } finally {
        await teardown();
      }
    });
  });

  it('retires each generation resource after its broker and keeps an uncertain inbox', async () => {
    await fixture(async (parent) => {
      const lifecycle = projectFixture();
      const open = vi.fn<OpenCustodyEndpoint>(async () => {
        throw new Error('Unexpected opening');
      });
      const firstRemove = vi.fn<GenerationEndpoint['remove']>(async () => 'closed');
      const secondRemove = vi.fn<GenerationEndpoint['remove']>(async () => 'cleanup-uncertain');
      const create = vi
        .fn<() => GenerationEndpoint>()
        .mockReturnValueOnce({ open, remove: firstRemove })
        .mockReturnValueOnce({ open, remove: secondRemove });
      const close = await createCustodySetup(open, parent, create)(lifecycle.project);
      const first = lifecycle.provided();
      await lifecycle.rerun();
      const second = lifecycle.provided();
      expect(first.inbox).not.toBe(second.inbox);
      await expect(readdir(first.inbox)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(firstRemove).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
      expect(secondRemove).not.toHaveBeenCalled();
      await expect(close()).rejects.toThrow(/cleanup could not be confirmed/);
      expect(secondRemove).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
      expect(await readdir(second.inbox)).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    });
  });

  it('is inert until a gated authenticated worker arrives and delivers independent scope close', async () => {
    await fixture(async (parent) => {
      const lifecycle = projectFixture();
      const scope = deferred();
      const connected = deferred();
      const closeMain = vi.fn();
      const joinScope = vi.fn(async () => 'closed' as const);
      const connection = { endpointId: '42'.repeat(16), token: '24'.repeat(32) };
      const open = vi.fn<OpenCustodyEndpoint>(async () => ({
        connection,
        closeMain,
        join: joinScope,
        scopeEnded: scope.promise,
        scopeConnected: connected.promise,
      }));
      const closeSetup = await createCustodySetup(open, parent)(lifecycle.project);
      try {
        expect(open).not.toHaveBeenCalled();
        const connect = vi.fn(async (_reply) => {
          connected.resolve();
          return { close: scope.resolve };
        });
        const options = {
          admitted: false,
          provided: lifecycle.provided(),
          connect,
          deadline: Date.now() + 2_000,
          signal: new AbortController().signal,
        };
        await expect(acquireWorkerCustody(options)).rejects.toThrow(/gate/);
        expect(await readdir(options.provided.inbox)).toEqual([]);
        expect(open).not.toHaveBeenCalled();
        const worker = await acquireWorkerCustody({ ...options, admitted: true });
        expect(connect).toHaveBeenCalledExactlyOnceWith(connection, expect.any(AbortSignal));
        expect(open).toHaveBeenCalledTimes(1);
        expect(closeMain).not.toHaveBeenCalled();
        await worker.close();
        await vi.waitFor(() => {
          expect(closeMain).toHaveBeenCalledTimes(1);
          expect(joinScope).toHaveBeenCalledTimes(1);
        });
      } finally {
        await closeSetup();
      }
      expect(await readdir(parent)).toEqual([]);
    });
  });

  it.each([false, true])(
    'aborts a pending connection and accounts for late channel close (throws: %s)',
    async (throws) => {
      await fixture(async (parent) => {
        const lifecycle = projectFixture();
        const scope = deferred();
        const connected = deferred();
        const closeMain = vi.fn();
        const open = vi.fn<OpenCustodyEndpoint>(async () => ({
          connection: { endpointId: '21'.repeat(16), token: '66'.repeat(32) },
          closeMain,
          join: async () => 'closed',
          scopeEnded: scope.promise,
          scopeConnected: connected.promise,
        }));
        const closeSetup = await createCustodySetup(open, parent)(lifecycle.project);
        try {
          const caller = new AbortController();
          const negotiated = deferred();
          const closeLateChannel = vi.fn(() => {
            if (throws) throw new Error('private-channel-close-secret');
          });
          const connect = vi.fn(async () => {
            await negotiated.promise;
            return { close: closeLateChannel };
          });
          const worker = acquireWorkerCustody({
            admitted: true,
            provided: lifecycle.provided(),
            connect,
            deadline: Date.now() + 2_000,
            signal: caller.signal,
          }).catch((error: unknown) => error);
          await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
          caller.abort();
          negotiated.resolve();
          const error = await worker;
          if (throws) {
            if (!(error instanceof AggregateError))
              throw new Error('Expected combined worker failure');
            expect(error.errors[0]).toMatchObject({
              message: expect.stringMatching(/deadline or owner expired/),
            });
            const cleanup: unknown = error.errors[1];
            if (!(cleanup instanceof WorkerCleanupError))
              throw new Error('Expected cleanup evidence');
            expect(cleanup.receipt).toEqual({
              kind: 'cleanup-uncertain',
              reason: 'adapter-failed',
              channel: 'failed',
              request: 'closed',
            });
            expect(JSON.stringify(cleanup)).not.toContain('private-channel-close-secret');
          } else {
            expect(error).toMatchObject({
              message: expect.stringMatching(/deadline or owner expired/),
            });
          }
          await vi.waitFor(() => {
            expect(closeLateChannel).toHaveBeenCalledTimes(1);
            expect(closeMain).toHaveBeenCalledTimes(1);
          });
        } finally {
          await closeSetup();
        }
      });
    }
  );

  it.each(['provide', 'onTestsRerun'] as const)(
    'removes the initial inbox when setup cannot register %s',
    async (hook) => {
      await fixture(async (parent) => {
        const { project } = projectFixture();
        const failure = new Error('fixture setup registration failed');
        const broken = {
          ...project,
          [hook]: () => {
            throw failure;
          },
        };
        const open = vi.fn<OpenCustodyEndpoint>();
        await expect(createCustodySetup(open, parent)(broken)).rejects.toBe(failure);
        expect(await readdir(parent)).toEqual([]);
        expect(open).not.toHaveBeenCalled();
      });
    }
  );

  it('rotates provided metadata on rerun and ignores old-generation or mismatched filenames', async () => {
    await fixture(async (parent) => {
      const lifecycle = projectFixture();
      const open = vi.fn<OpenCustodyEndpoint>(async () => {
        throw new Error('unexpected endpoint');
      });
      const closeSetup = await createCustodySetup(open, parent)(lifecycle.project);
      try {
        const old = lifecycle.provided();
        await lifecycle.rerun();
        const next = lifecycle.provided();
        expect(next.run.runId).toBe(old.run.runId);
        expect(next.run.generation).not.toBe(old.run.generation);
        expect(next.run.capability).not.toBe(old.run.capability);
        expect(next.inbox).not.toBe(old.inbox);
        expect(await readdir(parent)).toHaveLength(1);
        await expect(openOwnedInbox(old.inbox)).rejects.toMatchObject({ code: 'ENOENT' });

        const inbox = await openOwnedInbox(next.inbox);
        const requestId = '42'.repeat(16);
        const request = {
          kind: 'acquire' as const,
          requestId,
          scopeId: '31'.repeat(16),
          deadline: null,
        };
        const signal = new AbortController().signal;
        await inbox.write('request', requestId, encodeMetadata(old.run, request), signal);
        await inbox.write('cancel', requestId, encodeMetadata(next.run, request), signal);
        await inbox.write('request', '64'.repeat(16), encodeMetadata(next.run, request), signal);
        await vi.waitFor(async () => expect(await readdir(next.inbox)).toEqual([]));
        expect(open).not.toHaveBeenCalled();
      } finally {
        await closeSetup();
      }
    });
  });
});
