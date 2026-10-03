import { it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { createDiagnosticsOwner } from '../diagnostics.js';
import { createDiagnosticsBudget } from '../diagnostics-budget.js';
import { tabFixture } from '../../__tests__/parent-fixture.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
function fixture() {
  const h = tabFixture(),
    budget = createDiagnosticsBudget();
  let now = 0;
  const callbacks = new Map<string, (v: unknown) => void>();
  const page = {
    on: (name: string, cb: (v: unknown) => void) => callbacks.set(name, cb),
    off: (name: string) => callbacks.delete(name),
  };
  const owner = createDiagnosticsOwner({
    budget,
    readBinding: () => (h.tab.stopped ? null : h.tab.binding),
    now: () => now,
  });
  owner.install(page as unknown as Page);
  const request = { method: () => 'GET', resourceType: () => 'fetch' };
  return {
    h,
    budget,
    owner,
    callbacks,
    page,
    request,
    time: (v: number) => {
      now = v;
    },
    emit: (e: string, v: unknown) => callbacks.get(e)?.(v),
  };
}
it('normalizes fixed metadata only, preserves duplicate START and consumes terminal once', () => {
  const f = fixture(),
    secret = vi.fn(() => {
      throw Error('SECRET');
    });
  Object.defineProperty(f.request, 'url', { get: secret });
  f.emit('request', f.request);
  f.emit('request', f.request);
  expect(f.budget.snapshot().correlations).toBe(1);
  expect(f.owner.read()?.counts).toMatchObject({ dropped: 1, correlationDropped: 1, truncated: 1 });
  f.time(20);
  f.emit('response', { request: () => f.request, status: () => 204 });
  f.emit('requestfinished', f.request);
  f.emit('requestfailed', f.request);
  expect(f.budget.snapshot().correlations).toBe(0);
  expect(f.owner.read()?.entries).toHaveLength(3);
  expect(secret).not.toHaveBeenCalled();
  expect(f.owner.read()?.counts.unmatchedCallbacks).toBe(1);
  f.owner.discard();
  expect(f.budget.snapshot().owners).toBe(0);
});
it('same-binding nested allowed getter terminally refuses prospective entries with no queue', () => {
  const f = fixture();
  f.request.method = () => {
    f.emit('request', { method: () => 'GET', resourceType: () => 'fetch' });
    return 'GET';
  };
  f.emit('request', f.request);
  expect(f.owner.read()).toMatchObject({
    terminal: 'observerUnavailable',
    entries: [],
    subsequentEventsUncounted: true,
  });
  expect(f.budget.snapshot()).toMatchObject({ entries: 0, correlations: 0 });
});
it('nonfinite clock and failed off retain no allocating callback reachability', () => {
  const f = fixture();
  f.time(NaN);
  f.emit('request', f.request);
  expect(f.owner.read()?.terminal).toBe('observerUnavailable');
  const g = fixture(),
    cb = g.callbacks.get('request')!;
  g.page.off = () => {
    throw Error('OFF');
  };
  g.owner.discard();
  expect(g.owner.cleanupUnavailable()).toBe(true);
  expect(g.owner.read()).toBe(null);
  cb(g.request);
  expect(g.budget.snapshot()).toEqual({
    owners: 0,
    entries: 0,
    bytes: 0,
    correlations: 0,
    correlationBytes: 0,
  });
});
it('entry-full joint START refuses without stranding a correlation; replacement retains one owner', () => {
  const f = fixture();
  for (let i = 0; i < 256; i++) f.emit('console', { type: () => 'info' });
  f.emit('request', f.request);
  expect(f.owner.read()?.counts).toMatchObject({ dropped: 1, correlationDropped: 0 });
  expect(f.budget.snapshot().correlations).toBe(0);
  for (let i = 0; i < 20; i++) {
    f.h.tab.binding = { ...f.h.tab.binding, navigationGeneration: i + 1 };
    f.owner.replaceEpoch();
  }
  expect(f.budget.snapshot()).toMatchObject({ owners: 1, entries: 0, correlations: 0 });
});
it('retirement during the method observation prevents the subsequent resource getter', () => {
  const f = fixture(),
    resource = vi.fn(() => 'fetch');
  f.request.method = () => {
    f.h.tab.stopped = true;
    return 'GET';
  };
  f.request.resourceType = resource;
  f.emit('request', f.request);
  expect(resource).not.toHaveBeenCalled();
  expect(f.owner.read()?.entries).toEqual([]);
  expect(f.budget.snapshot().correlations).toBe(0);
});
it('binding getter reentry cannot admit an entry before terminalizing the observer', () => {
  const h = tabFixture(),
    budget = createDiagnosticsBudget(),
    callbacks = new Map<string, (v: unknown) => void>();
  let reenter = false;
  const owner = createDiagnosticsOwner({
    budget,
    readBinding: () => {
      if (reenter) {
        reenter = false;
        callbacks.get('console')?.({ type: () => 'info' });
      }
      return h.tab.binding;
    },
    now: () => 0,
  });
  owner.install({
    on: (e: string, cb: (v: unknown) => void) => callbacks.set(e, cb),
    off: () => {},
  } as unknown as Page);
  reenter = true;
  callbacks.get('console')?.({ type: () => 'info' });
  expect(owner.read()).toMatchObject({ terminal: 'observerUnavailable', entries: [] });
  expect(budget.snapshot().entries).toBe(0);
});
it('terminal snapshots stay charged until discarded and capacity refusal installs no listeners', () => {
  const budget = createDiagnosticsBudget(),
    h = tabFixture(),
    owners = [];
  for (let i = 0; i < 16; i++) {
    let cb: (v: unknown) => void = () => {};
    let clock = 0;
    const owner = createDiagnosticsOwner({
      budget,
      readBinding: () => h.tab.binding,
      now: () => clock,
    });
    owner.install({
      on: (e: string, f: (v: unknown) => void) => {
        if (e === 'console') cb = f;
      },
      off: () => {},
    } as unknown as Page);
    cb({ type: () => 'info' });
    clock = NaN;
    cb({ type: () => 'info' });
    owners.push(owner);
  }
  expect(budget.snapshot()).toMatchObject({ owners: 16, entries: 16 });
  const on = vi.fn();
  const refused = createDiagnosticsOwner({
    budget,
    readBinding: () => h.tab.binding,
    now: () => 0,
  });
  refused.install({ on } as unknown as Page);
  expect(on).not.toHaveBeenCalled();
  expect(refused.read()).toBe(null);
  owners[0]!.discard();
  expect(budget.snapshot()).toMatchObject({ owners: 15, entries: 15 });
});
it('serializes actual maximum-width normalized entries and retained engine container within charged bounds', () => {
  const h = tabFixture(),
    budget = createDiagnosticsBudget(),
    owners = [];
  const max = Number.MAX_SAFE_INTEGER;
  h.tab.binding = {
    ...h.tab.binding,
    browserId: parseBrowserId('B'.repeat(64)),
    tabId: parseTabId('T'.repeat(64)),
    browserGeneration: max,
    navigationGeneration: max,
    viewportVersion: max,
    epoch: max,
    inputGeneration: max,
  };
  for (let i = 0; i < 16; i++) {
    const callbacks = new Map<string, (v: unknown) => void>();
    let clock = 0;
    const owner = createDiagnosticsOwner({
      budget,
      readBinding: () => h.tab.binding,
      now: () => clock,
    });
    owner.install({
      on: (e: string, cb: (v: unknown) => void) => callbacks.set(e, cb),
      off: () => {},
    } as unknown as Page);
    clock = max;
    for (let j = 0; j < 256; j++)
      callbacks.get('request')?.({ method: () => 'OPTIONS', resourceType: () => 'document' });
    owners.push(owner);
  }
  const summaries = owners.map((o) => o.read()!);
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const state = budget.snapshot();
  expect(state).toMatchObject({ owners: 16, entries: 4096, correlations: 4096 });
  for (const summary of summaries) {
    expect(encode(summary)).toBeLessThanOrEqual(266240);
    expect(encode({ ...summary, entries: [] })).toBeLessThanOrEqual(4096);
    for (const entry of summary.entries)
      expect(encode({ binding: summary.binding, entry }) + 1).toBeLessThanOrEqual(1024);
  }
  expect(encode(summaries)).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(state.bytes + 16 * 4096).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(state.correlationBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  console.info(
    'CAPTURE45_NORMALIZED_WIDTH',
    JSON.stringify({
      owners: summaries.length,
      entries: state.entries,
      containerBytes: encode(summaries),
      wrapperBytes: encode({ ...summaries[0], entries: [] }),
      chargedProjectionBytes: state.bytes,
      reservedWrapperBytes: 16 * 4096,
      chargedCorrelationBytes: state.correlationBytes,
    })
  );
  for (const owner of owners) owner.discard();
  expect(budget.snapshot().owners).toBe(0);
});
it('replacement clock retirement retains the old charged history without relabeling it', () => {
  const h = tabFixture(),
    budget = createDiagnosticsBudget(),
    callbacks = new Map<string, (v: unknown) => void>();
  let mutate = false;
  const owner = createDiagnosticsOwner({
    budget,
    readBinding: () => h.tab.binding,
    now: () => {
      if (mutate) h.tab.binding = { ...h.tab.binding, epoch: h.tab.binding.epoch + 1 };
      return 0;
    },
  });
  owner.install({
    on: (e: string, cb: (v: unknown) => void) => callbacks.set(e, cb),
    off: () => {},
  } as unknown as Page);
  callbacks.get('console')?.({ type: () => 'info' });
  const original = owner.read()!;
  h.tab.binding = { ...h.tab.binding, navigationGeneration: 1 };
  mutate = true;
  owner.replaceEpoch();
  expect(owner.read()).toMatchObject({
    binding: original.binding,
    entries: original.entries,
    terminal: 'observerUnavailable',
  });
  expect(budget.snapshot()).toMatchObject({ owners: 1, entries: 1 });
});
it('actual clock callback nesting and backwards samples terminalize without prospective commits', () => {
  const h = tabFixture(),
    budget = createDiagnosticsBudget(),
    callbacks = new Map<string, (v: unknown) => void>();
  const now = 10;
  let reenter = false;
  const owner = createDiagnosticsOwner({
    budget,
    readBinding: () => h.tab.binding,
    now: () => {
      if (reenter) {
        reenter = false;
        callbacks.get('console')?.({ type: () => 'info' });
      }
      return now;
    },
  });
  owner.install({
    on: (e: string, cb: (v: unknown) => void) => callbacks.set(e, cb),
    off: () => {},
  } as unknown as Page);
  reenter = true;
  callbacks.get('console')?.({ type: () => 'info' });
  expect(owner.read()).toMatchObject({ terminal: 'observerUnavailable', entries: [] });
  expect(budget.snapshot().entries).toBe(0);
  const f = fixture();
  f.time(2);
  f.emit('console', { type: () => 'info' });
  f.time(1);
  f.emit('console', { type: () => 'info' });
  expect(f.owner.read()).toMatchObject({
    terminal: 'observerUnavailable',
    entries: [{ sequence: 1 }],
  });
  expect(f.budget.snapshot().entries).toBe(1);
});

it('maps the SDK stylesheet category to the bounded style value', () => {
  const f = fixture();
  f.request.resourceType = () => 'stylesheet';
  f.emit('request', f.request);
  expect(f.owner.read()?.entries).toEqual([expect.objectContaining({ resource: 'style' })]);
  f.owner.discard();
});
