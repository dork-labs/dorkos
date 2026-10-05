import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import {
  fixtureWorkerScripts,
  readSharedFixture,
  parseFixtureWorkerResult,
  readFixtureWorker,
} from './fixture-workers.js';

it('the actual nested script closes its original child when parent fetch fails before the child result', async () => {
  const primary = new Error('parent fetch refused');
  const terminate = vi.fn();
  const postMessage = vi.fn();
  // Synthetic script custody control only; this supplies no native browser evidence.
  const self: { onmessage?: () => Promise<void> } = {};
  vm.runInNewContext(
    fixtureWorkerScripts('async function readIdentity(){return {fixture:true};}').nested,
    {
      self,
      postMessage,
      Error,
      fetch: () => Promise.reject(primary),
      Worker: class {
        terminate = terminate;
        postMessage() {}
      },
    }
  );
  await self.onmessage!();
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenLastCalledWith({ error: 'parent fetch refused' });
});

it('shared observation timeout closes the actual acquired port before rejecting', async () => {
  const close = vi.fn(),
    postMessage = vi.fn(),
    start = vi.fn();
  let timeout!: () => void;
  const context = {
    SharedWorker: class {
      port = { close, postMessage, start };
    },
    setTimeout: (callback: () => void) => {
      timeout = callback;
      return 1;
    },
    clearTimeout: vi.fn(),
    Error,
  };
  const read = vm.runInNewContext(readSharedFixture, context) as (
    phase: string
  ) => Promise<unknown>;
  const original = read('fixture-timeout');
  timeout();
  await expect(original).rejects.toThrow('SHARED_WORKER_TIMEOUT');
  expect(close).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith('fixture-timeout');
});

it('preserves the shared timeout cause through a throwing close and a late message-error callback', async () => {
  const close = vi.fn(() => {
    throw new Error('port close refused');
  });
  let timeout!: () => void;
  const port: {
    close: () => void;
    postMessage: () => void;
    start: () => void;
    onmessageerror?: () => void;
  } = { close, postMessage: () => {}, start: () => {} };
  const read = vm.runInNewContext(readSharedFixture, {
    SharedWorker: class {
      port = port;
    },
    setTimeout: (callback: () => void) => {
      timeout = callback;
      return 1;
    },
    clearTimeout: () => {},
    Error,
  }) as (phase: string) => Promise<unknown>;
  const original = read('fixture-timeout');
  timeout();
  port.onmessageerror!();
  await expect(original).rejects.toThrow('SHARED_WORKER_TIMEOUT');
  expect(close).toHaveBeenCalledTimes(1);
});

it('refuses an actual nested-parent payload that omits its claimed child identity', () => {
  const identity = {
    userAgent: 'fixture',
    appVersion: 'fixture',
    platform: 'fixture',
    secureContext: true,
    metadata: null,
  };
  expect(() => parseFixtureWorkerResult('nested-parent', { identity })).toThrow();
  expect(parseFixtureWorkerResult('nested-parent', { identity, nested: identity }).nested).toEqual(
    identity
  );
  expect(parseFixtureWorkerResult('dedicated', { identity }).identity).toEqual(identity);
});

it('observes child rejection immediately while parent fetch is withheld and preserves the parent failure', async () => {
  let rejectFetch!: (error: Error) => void;
  const fetchOriginal = new Promise((_resolve, reject) => {
    rejectFetch = reject;
  });
  const terminate = vi.fn(),
    postMessage = vi.fn();
  const child: {
    onerror?: (event: { message: string }) => void;
    terminate: () => void;
    postMessage: () => void;
  } = { terminate, postMessage: () => {} };
  const unhandled = vi.fn();
  const self: { onmessage?: () => Promise<void> } = {};
  process.on('unhandledRejection', unhandled);
  try {
    vm.runInNewContext(
      fixtureWorkerScripts('async function readIdentity(){return {fixture:true};}').nested,
      {
        self,
        postMessage,
        Error,
        fetch: () => fetchOriginal,
        Worker: class {
          constructor() {
            return child;
          }
        },
      }
    );
    const original = self.onmessage!();
    child.onerror!({ message: 'child failed before parent fetch' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    rejectFetch(new Error('parent fetch refused'));
    await original;
    expect(postMessage).toHaveBeenLastCalledWith({ error: 'parent fetch refused' });
    expect(terminate).toHaveBeenCalledTimes(1);
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

it('dedicated ready acknowledgment is sent only after its real script installs the message listener', () => {
  const self: { onmessage?: () => Promise<void> } = {};
  const postMessage = vi.fn((message: { stage?: string }) => {
    if (message.stage === 'script-ready') expect(typeof self.onmessage).toBe('function');
  });
  vm.runInNewContext(
    fixtureWorkerScripts('async function readIdentity(){return {fixture:true};}').dedicated,
    { self, postMessage, Error }
  );
  expect(postMessage).toHaveBeenCalledWith({ stage: 'script-ready' });
});

it('the actual client protocol sends no early trigger and handles duplicate readiness without a second trigger', async () => {
  const postMessage = vi.fn(),
    terminate = vi.fn();
  const worker: {
    postMessage: () => void;
    terminate: () => void;
    onmessage?: (event: { data: unknown }) => void;
  } = { postMessage, terminate };
  const read = vm.runInNewContext(readFixtureWorker, {
    Worker: class {
      constructor() {
        return worker;
      }
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    Error,
  }) as (script: string) => Promise<unknown>;
  const original = read('/fixture.js');
  expect(postMessage).not.toHaveBeenCalled();
  worker.onmessage!({ data: { stage: 'script-ready' } });
  worker.onmessage!({ data: { stage: 'script-ready' } });
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith('observe');
  worker.onmessage!({ data: { identity: { fixture: true } } });
  await expect(original).resolves.toMatchObject({ result: { identity: { fixture: true } } });
  expect(terminate).toHaveBeenCalledTimes(1);
});
