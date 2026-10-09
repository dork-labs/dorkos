import { EventEmitter } from 'node:events';
import {
  ownCrashRetirement,
  noteOriginalRootFailure,
  observedCrashCause,
} from '../runtime/crash-custody.js';
import { expect, it, vi, onTestFinished } from 'vitest';
import { record, configuration, deferred, tick } from './parent-fixture.js';
import { restoreProfileStorageState } from '../profiles/restore-state.js';
import { parseProfileStorageState } from '../profiles/storage-state.js';
import { closeRecord } from '../lifecycle/close.js';
import { fenceOrdinary } from '../lifecycle/ownership.js';
import { reserveProfile } from '../profiles/reservation.js';
import { parseProfileId } from '../ids.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it.each([false, undefined])(
  'owns a held original restore, joins retirement and retains exact rejection %s',
  async (cause) => {
    const owned = record(),
      returned = deferred<void>();
    const state = parseProfileStorageState({ cookies: [], origins: [] });
    owned.mode = 'persistent';
    owned.initialStorageState = state;
    const context = {
      close: owned.context!.close.bind(owned.context),
      setStorageState: vi.fn(function (this: unknown, value: unknown) {
        expect(this).toBe(context);
        expect(value).toBe(state);
        return returned.promise;
      }),
    };
    owned.context = context as unknown as NonNullable<typeof owned.context>;
    const original = restoreProfileStorageState(owned, () => owned.lifetime.gate.stopped);
    const outcome = original.then(
      () => ({ resolved: true as const }),
      (value: unknown) => ({ value })
    );
    fenceOrdinary(owned, 'authorityRevoked');
    const closing = closeRecord(configuration(), owned);
    onTestFinished(async () => {
      returned.resolve();
      await Promise.allSettled([original, closing]);
    });
    await tick();
    expect(context.setStorageState).toHaveBeenCalledTimes(1);
    expect(owned.lifetime.ordinary.retirement.pendingCoverage.size).toBe(1);
    returned.reject(cause);
    const settled = await outcome;
    expect(settled).toStrictEqual({ value: cause });
    expect((await closing).cleanup).toBe('unverified');
    expect(owned.initialStorageState).toBeUndefined();
  }
);
it('never restores into clean mode and never retains rejected state in the record', async () => {
  const owned = record();
  owned.mode = 'ephemeral';
  owned.initialStorageState = parseProfileStorageState({ cookies: [], origins: [] });
  const restore = vi.fn();
  owned.context = { setStorageState: restore } as unknown as NonNullable<typeof owned.context>;
  await expect(restoreProfileStorageState(owned, () => false)).rejects.toThrow();
  expect(restore).not.toHaveBeenCalled();
  expect(owned.initialStorageState).toBeUndefined();
});
it('refuses a fresh import reservation when an existing reservation already owns the ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-import-'));
  const id = parseProfileId('profile_original_reference_0001');
  try {
    await mkdir(join(root, 'reservations'), { recursive: true });
    await mkdir(join(root, 'reservations', id));
    await expect(
      reserveProfile(configuration(), root, id, { pid: 1, birth: 'fixture-manager' }, true)
    ).rejects.toThrow('PROFILE_UNCERTAIN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains original native crash ownership before held restoration and refuses publication after native loss', async () => {
  const owned = record(),
    browser = new EventEmitter(),
    contextEvents = new EventEmitter();
  const returned = deferred<void>();
  const context = Object.assign(contextEvents, {
    browser: () => browser,
    pages: () => [],
    close: owned.context!.close.bind(owned.context),
    setStorageState: vi.fn(() => {
      expect(browser.listenerCount('disconnected')).toBe(1);
      expect(contextEvents.listenerCount('close')).toBe(1);
      expect(owned.rootAttributed).toBe(true);
      return returned.promise;
    }),
  });
  owned.context = context as unknown as NonNullable<typeof owned.context>;
  owned.initialStorageState = parseProfileStorageState({ cookies: [], origins: [] });
  ownCrashRetirement(owned, owned.context);
  const original = restoreProfileStorageState(
    owned,
    () => owned.lifetime.ordinary.phase !== 'ordinary'
  );
  const outcome = original.catch((value: unknown) => ({ value }));
  onTestFinished(async () => {
    returned.resolve();
    await Promise.allSettled([original]);
  });
  noteOriginalRootFailure(owned);
  expect(observedCrashCause(owned)).toBe('browser');
  expect(owned.tabs.size).toBe(0);
  returned.resolve();
  expect((await outcome)?.value).toMatchObject({ code: 'ENGINE_STOPPED' });
  expect(owned.initialStorageState).toBeUndefined();
});
