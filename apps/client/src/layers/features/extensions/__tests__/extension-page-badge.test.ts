/**
 * @vitest-environment jsdom
 */
/**
 * `api.setPageBadge` (DOR-2820) driven through the real API factory and the
 * real extension registry, the way an extension's `activate()` would drive it.
 * What the tab draws from the badge is pinned beside the hook that reads it, in
 * `app-tabs/__tests__/use-tab-identity.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSlots, useAppStore, useExtensionRegistry } from '@/layers/shared/model';
import { createExtensionAPI } from '../model/extension-api-factory';
import type { ExtensionAPIDeps } from '../model/types';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

/** Host deps wired to the real registry, as `main.tsx` wires them. */
function realDeps(): ExtensionAPIDeps {
  return {
    registry: useExtensionRegistry.getState() as unknown as ExtensionAPIDeps['registry'],
    eventBridge: { subscribe: vi.fn(() => () => {}) },
    dispatcherContext: {
      getStore: () => ({}) as ReturnType<ExtensionAPIDeps['dispatcherContext']['getStore']>,
      setTheme: vi.fn(),
    },
    navigate: vi.fn(),
    appStore: useAppStore as unknown as ExtensionAPIDeps['appStore'],
    availableSlots: new Set(),
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
  };
}

const Page = () => null;
const badges = () => useExtensionRegistry.getState().pageBadges;

beforeEach(() => {
  useExtensionRegistry.setState({ slots: createInitialSlots(), tabMarkers: {}, pageBadges: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setPageBadge', () => {
  it('badges a page the extension registered, and clears it', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });

    api.setPageBadge('', { status: 'needs-you', count: 2, sentence: '2 ideas wait for you' });
    expect(badges()).toEqual({
      'flow:': { status: 'needs-you', count: 2, sentence: '2 ideas wait for you' },
    });

    api.setPageBadge('', null);
    expect(badges()).toEqual({});
  });

  it('keys a badge on a param page by its registered path', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('p/:name', Page, { title: 'Project' });

    api.setPageBadge('p/:name', { status: 'working' });

    expect(badges()).toEqual({ 'flow:p/:name': { status: 'working' } });
  });

  it('keeps its own copy, trimmed, so a later change to the object does not reach the tab', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });
    const badge = { count: 1, sentence: '  1 new idea  ' };

    api.setPageBadge('', badge);
    badge.count = -5;

    expect(badges()['flow:']).toEqual({ count: 1, sentence: '1 new idea' });
  });

  it('does nothing, out loud, for a page it did not register', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createExtensionAPI('other', realDeps()).api.registerPage('', Page, { title: 'Other' });
    const { api } = createExtensionAPI('flow', realDeps());

    api.setPageBadge('', { status: 'failed' });

    expect(badges()).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    ['an unknown status', { status: 'urgent' }],
    ['a negative count', { count: -1 }],
    ['a fractional count', { count: 0.5 }],
    ['a sentence over 80 characters', { sentence: 'x'.repeat(81) }],
  ])('ignores %s, out loud, and keeps the badge it had', (_name, bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });
    api.setPageBadge('', { count: 1 });

    // An untyped extension can pass anything; the host checks rather than trusts.
    api.setPageBadge('', bad as never);

    expect(badges()).toEqual({ 'flow:': { count: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/setPageBadge\(''\) was ignored/));
  });

  it('clears its badges, and only its own, when the extension deactivates', () => {
    const other = createExtensionAPI('flow-extra', realDeps()).api;
    other.registerPage('', Page, { title: 'Extra' });
    other.setPageBadge('', { status: 'new' });
    const { api, cleanups } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });
    api.setPageBadge('', { status: 'needs-you' });

    for (const fn of cleanups) fn();

    expect(badges()).toEqual({ 'flow-extra:': { status: 'new' } });
  });
});
