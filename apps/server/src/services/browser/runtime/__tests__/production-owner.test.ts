import { expect, it, onTestFinished, vi } from 'vitest';
import { authors, createDb, runMigrations } from '@dorkos/db';
import type { EngineConfiguration } from '@dorkos/browser';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserBirthOwner,
} from '@dorkos/browser/server-owner';
import { BrowserRegistryStore } from '../../registry/store.js';
import { BrowserRegistry } from '../../registry/registry.js';
import { installedPublisherAnchor } from '../installed-publisher-anchor.mjs';
import { createProductionBrowserRuntimeOwner } from '../production-owner.js';

// Real registry/installed issuer. Controlled participant methods are never
// accepted release/native/broker authority: every case stops before VM birth.
function fixture() {
  const db = createDb(':memory:');
  const owner = createProductionBrowserRuntimeOwner();
  const entered: Promise<unknown>[] = [],
    accepted: unknown[] = [];
  onTestFinished(async () => {
    const closing = owner.close();
    const joined = await Promise.allSettled([closing, ...entered]);
    let first: { value: unknown } | undefined;
    for (const row of joined)
      if (row.status === 'rejected' && !accepted.some((value) => Object.is(value, row.reason)))
        first ??= { value: row.reason };
    try {
      db.$client.close();
    } catch (value) {
      first ??= { value };
    }
    if (first) throw first.value;
  });
  runMigrations(db);
  db.insert(authors)
    .values({
      id: 'alice',
      kind: 'human',
      naturalKey: 'user:alice',
      displayName: 'Alice',
      createdAt: '2026-10-09T00:00:00.000Z',
    })
    .run();
  const store = new BrowserRegistryStore(db, 'original-test-boot');
  const registry = new BrowserRegistry(store, () => true);
  const birth = registry.birthOwner('alice', { mode: 'ephemeral' });
  const bindEngine = vi.fn((_engine: BrowserLifecycleEngine) => {});
  const registerInput = vi.fn(),
    registerCapture = vi.fn(),
    registerNavigation = vi.fn();
  const bindBeforeLaunch = vi.fn(async () => {
    throw new Error('UNENTERED_NETWORK');
  });
  const activateReady = vi.fn(async () => {
    throw new Error('UNENTERED_READY');
  });
  const participant: PrivateBrowserBirthOwner & {
    bindEngine(engine: BrowserLifecycleEngine): void;
  } = {
    ...birth,
    bindEngine,
    input: { registerDispatcher: registerInput },
    capture: { registerDispatcher: registerCapture },
    navigation: { registerDispatcher: registerNavigation },
    network: { bindBeforeLaunch, activateReady },
  };
  const settings: Omit<EngineConfiguration, 'runtime'> = {
    dataDir: '/unentered-browser',
    network: { kind: 'owned', origin: 'about:blank', policyRevision: 1 },
    clock: { wallNow: Date.now, monotonicNow: performance.now },
    processes: {
      observe: async () => ({ status: 'unknown' }),
      descendants: async () => ({ status: 'unknown', identities: [] }),
    },
    policy: { authorizeAction: async () => 'refused', verifyBrokerLease: async () => 'revoked' },
  };
  const command = { kind: 'open', requestId: 'r'.repeat(22), mode: 'ephemeral' };
  const track = <T>(original: Promise<T>): Promise<T> => {
    entered.push(original);
    void original.catch(() => {});
    return original;
  };
  const open = (signal?: AbortSignal, mode: 'native' | 'chrome-compatible' = 'native') =>
    track(
      owner.open(settings, participant, command, signal, mode, undefined, {
        registry: store,
        ownerId: 'alice',
      })
    );
  const rejected = async (original: Promise<unknown>) => {
    try {
      await original;
    } catch (value) {
      accepted.push(value);
      return { value };
    }
    throw new Error('EXPECTED_ORIGINAL_REFUSAL');
  };
  const unentered = () => {
    expect(store.rows()).toHaveLength(0);
    expect(bindEngine).not.toHaveBeenCalled();
    for (const call of [
      registerInput,
      registerCapture,
      registerNavigation,
      bindBeforeLaunch,
      activateReady,
    ])
      expect(call).not.toHaveBeenCalled();
  };
  return { owner, settings, participant, store, command, open, track, rejected, unentered };
}

it.each(['native', 'chrome-compatible'] as const)(
  'empty installed catalogue refuses %s without registry birth or VM effects',
  async (mode) => {
    const f = fixture();
    expect(installedPublisherAnchor).toBeNull();
    const failure = await f.rejected(f.open(undefined, mode));
    expect(failure.value).toBeInstanceOf(Error);
    expect(failure.value).toMatchObject({
      message:
        process.platform === 'darwin' && process.arch === 'arm64'
          ? 'INSTALLED_PUBLISHER_ANCHOR_REQUIRED'
          : 'INSTALLED_RUNTIME_STAGE',
    });
    await expect(f.owner.close()).rejects.toBe(failure.value);
    f.unentered();
  }
);

it('requires the original registry store selection before installed acquisition', async () => {
  const f = fixture();
  const failure = await f.rejected(
    f.track(f.owner.open(f.settings, f.participant, f.command, undefined))
  );
  expect(failure.value).toMatchObject({ code: 'UNSUPPORTED' });
  await expect(f.owner.close()).rejects.toBe(failure.value);
  f.unentered();
});

it('requires all private participant roles before installed acquisition', async () => {
  const f = fixture();
  const failure = await f.rejected(
    f.track(
      f.owner.open(
        f.settings,
        { ...f.participant, capture: undefined },
        f.command,
        undefined,
        'native',
        undefined,
        { registry: f.store, ownerId: 'alice' }
      )
    )
  );
  expect(failure.value).toMatchObject({ code: 'UNSUPPORTED' });
  f.unentered();
});

it('refuses an unsupported identity mode before private participant reads', async () => {
  const f = fixture(),
    read = vi.fn(() => {
      throw new Error('MUST_NOT_READ');
    });
  Object.defineProperty(f.participant, 'input', { get: read });
  const original: Promise<unknown> = Reflect.apply(f.owner.open, f.owner, [
    f.settings,
    f.participant,
    f.command,
    undefined,
    'unsupported',
    undefined,
    { registry: f.store, ownerId: 'alice' },
  ]);
  const failure = await f.rejected(f.track(original));
  expect(failure.value).toMatchObject({ code: 'UNSUPPORTED' });
  expect(read).not.toHaveBeenCalled();
  f.unentered();
});

it.each([false, undefined])(
  'retains original participant getter failure %s through independent close',
  async (value) => {
    const f = fixture();
    Object.defineProperty(f.participant.navigation, 'registerDispatcher', {
      get() {
        throw value;
      },
    });
    const failure = await f.rejected(f.open());
    expect(failure.value).toBe(value);
    await expect(f.owner.close()).rejects.toBe(value);
    f.unentered();
  }
);

it('reserves the original opening before a participant getter reenters', async () => {
  const f = fixture(),
    input = f.participant.input;
  let inner: Promise<unknown> | undefined;
  Object.defineProperty(f.participant, 'input', {
    get() {
      inner = f.open();
      return input;
    },
  });
  const outer = f.open(),
    outerFailure = await f.rejected(outer);
  if (!inner) throw new Error('EXPECTED_REENTRANT_OPEN');
  const innerFailure = await f.rejected(inner);
  expect(innerFailure.value).toMatchObject({ code: 'BUSY' });
  await expect(f.owner.close()).rejects.toBe(outerFailure.value);
  f.unentered();
});

it('reentrant binder getter close fences installed work and retains the original open', async () => {
  const f = fixture();
  let closing: Promise<void> | undefined;
  Object.defineProperty(f.participant, 'bindEngine', {
    get() {
      closing = f.owner.close();
      void closing.catch(() => {});
      return () => {
        throw new Error('MUST_NOT_BIND');
      };
    },
  });
  const failure = await f.rejected(f.open());
  expect(failure.value).toMatchObject({ code: 'CLOSED' });
  expect(closing).toBe(f.owner.close());
  await expect(closing).rejects.toBe(failure.value);
  f.unentered();
});

it.each([false, undefined])(
  'aborted original signal preserves exact cause %s without installed work',
  async (value) => {
    const f = fixture(),
      controller = new AbortController();
    // AbortController substitutes AbortError for undefined, so capture its exact
    // original reason rather than pretending an undefined abort can be emitted.
    controller.abort(value);
    const failure = await f.rejected(f.open(controller.signal));
    expect(failure.value).toBe(controller.signal.reason);
    await expect(f.owner.close()).rejects.toBe(controller.signal.reason);
    f.unentered();
  }
);

it('a closed owner refuses new acquisition without reserving a registry row', async () => {
  const f = fixture();
  await f.owner.close();
  const failure = await f.rejected(f.open());
  expect(failure.value).toMatchObject({ code: 'CLOSED' });
  await f.owner.close();
  f.unentered();
});
