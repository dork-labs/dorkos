import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import {
  ownCrashRetirement,
  observedCrashCause,
  noteOriginalRootFailure,
} from '../runtime/crash-custody.js';
import { record } from './parent-fixture.js';

function fixture() {
  const owned = record(),
    browser = new EventEmitter(),
    context = new EventEmitter(),
    page = new EventEmitter();
  Object.assign(context, { browser: () => browser, pages: () => [page] });
  owned.context = context as unknown as BrowserContext;
  return { owned, browser, context, page };
}

// Semantic original event-owner controls; real renderer/browser crash acceptance is a separate native fixture.
it.each(['renderer', 'browser'] as const)(
  'synchronously fences original IDs for %s loss without replay',
  (cause) => {
    const f = fixture();
    ownCrashRetirement(f.owned, f.owned.context!);
    let laterOrdinary = true;
    const target = cause === 'renderer' ? f.page : f.browser;
    const event = cause === 'renderer' ? 'crash' : 'disconnected';
    target.on(event, () => {
      laterOrdinary = f.owned.lifetime.ordinary.phase === 'ordinary';
    });
    target.emit(event);
    expect(laterOrdinary).toBe(false);
    expect(observedCrashCause(f.owned)).toBe(cause);
    expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
    f.browser.emit('disconnected');
    f.page.emit('crash');
    expect(observedCrashCause(f.owned)).toBe(cause);
  }
);

it('enrolls each original late Page once and preserves the first renderer cause', () => {
  const f = fixture(),
    late = new EventEmitter();
  ownCrashRetirement(f.owned, f.owned.context!);
  f.context.emit('page', late as unknown as Page);
  f.context.emit('page', late as unknown as Page);
  expect(late.listenerCount('crash')).toBe(1);
  late.emit('crash');
  expect(observedCrashCause(f.owned)).toBe('renderer');
});

it('ordinary shutdown and callbacks from a replaced context cannot invent a crash', () => {
  const f = fixture();
  ownCrashRetirement(f.owned, f.owned.context!);
  f.owned.lifetime.requestRetirement('explicitStop');
  f.browser.emit('disconnected');
  f.page.emit('crash');
  expect(observedCrashCause(f.owned)).toBeNull();
  const g = fixture();
  ownCrashRetirement(g.owned, g.owned.context!);
  g.owned.context = new EventEmitter() as unknown as BrowserContext;
  g.browser.emit('disconnected');
  expect(observedCrashCause(g.owned)).toBeNull();
});

it.each([undefined, null, false, 0, ''])(
  'retains ownership and primary listener failure %s',
  (primary) => {
    const f = fixture();
    Object.defineProperty(f.page, 'on', {
      get() {
        throw primary;
      },
    });
    let observed: unknown,
      failed = false;
    try {
      ownCrashRetirement(f.owned, f.owned.context!);
    } catch (error) {
      observed = error;
      failed = true;
    }
    expect(failed).toBe(true);
    expect(observed).toBe(primary);
    expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
    expect(() => ownCrashRetirement(f.owned, f.owned.context!)).toThrow('CRASH_OWNER_REFUSED');
  }
);

it('late original listener failure fences admission without escaping its native event callback', () => {
  const f = fixture(),
    late = new EventEmitter();
  ownCrashRetirement(f.owned, f.owned.context!);
  Object.defineProperty(late, 'on', {
    get() {
      throw new Error('LATE_ORIGINAL_LISTENER_FAILURE');
    },
  });
  expect(() => f.context.emit('page', late)).not.toThrow();
  expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
  expect(f.owned.lifetime.uncertain).toBe(true);
  expect(observedCrashCause(f.owned)).toBeNull();
});

it('fences the original cohort before fallible crash persistence can reenter admission', () => {
  const f = fixture();
  let called = 0;
  f.owned.reservation = {
    profileDir: '/private/semantic-profile',
    nonce: 'semantic-nonce',
    recordJournal() {},
    beginLaunch() {},
    recordBrowser() {},
    release: async () => {},
    recordFailure(cause) {
      called++;
      expect(cause).toBe('renderer');
      expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
      expect(observedCrashCause(f.owned)).toBe('renderer');
      throw new Error('ORIGINAL_PERSISTENCE_FAILED');
    },
  };
  ownCrashRetirement(f.owned, f.owned.context!);
  expect(() => f.page.emit('crash')).not.toThrow();
  f.browser.emit('disconnected');
  expect(called).toBe(1);
  expect(f.owned.lifetime.uncertain).toBe(true);
  expect(observedCrashCause(f.owned)).toBe('renderer');
});

it('original context loss records browser failure before a later disconnected callback', () => {
  const f = fixture();
  ownCrashRetirement(f.owned, f.owned.context!);
  f.context.emit('close');
  f.browser.emit('disconnected');
  expect(observedCrashCause(f.owned)).toBe('browser');
  expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
});

it('actual original root exit retains browser cause after an earlier native input-loss fence', () => {
  const f = fixture();
  let writes = 0;
  f.owned.reservation = {
    profileDir: '/private/semantic-profile',
    nonce: 'semantic-nonce',
    recordJournal() {},
    beginLaunch() {},
    recordBrowser() {},
    release: async () => {},
    recordFailure(cause) {
      writes++;
      expect(cause).toBe('browser');
      expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
    },
  };
  ownCrashRetirement(f.owned, f.owned.context!);
  f.owned.lifetime.requestRetirement('engineFault');
  f.browser.emit('disconnected');
  expect(observedCrashCause(f.owned)).toBeNull();
  noteOriginalRootFailure(f.owned);
  noteOriginalRootFailure(f.owned);
  expect(observedCrashCause(f.owned)).toBe('browser');
  expect(writes).toBe(1);
});

it.each(['explicitStop', 'disabled', 'authorityRevoked', 'persistenceFailure'] as const)(
  'late original root failure cannot turn earlier %s retirement into a browser crash',
  (cause) => {
    const f = fixture();
    ownCrashRetirement(f.owned, f.owned.context!);
    f.owned.lifetime.requestRetirement(cause);
    noteOriginalRootFailure(f.owned);
    f.context.emit('close');
    f.browser.emit('disconnected');
    expect(observedCrashCause(f.owned)).toBeNull();
    expect(f.owned.lifetime.ordinary.retirement.firstCause).toBe(cause);
    expect(f.owned.lifetime.ordinary.phase).toBe('retiring');
  }
);
