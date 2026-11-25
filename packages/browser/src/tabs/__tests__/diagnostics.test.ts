import { it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { createDiagnosticsOwner } from '../diagnostics.js';
import { createDiagnosticsBudget } from '../diagnostics-budget.js';
import { tabFixture } from '../../__tests__/parent-fixture.js';
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
