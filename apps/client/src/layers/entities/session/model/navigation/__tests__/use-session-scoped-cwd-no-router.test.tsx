/**
 * @vitest-environment jsdom
 *
 * `useSessionScopedCwd` mounted with NO `RouterProvider` and nothing stubbed.
 *
 * Its sibling `use-session-scoped-cwd.test.tsx` stubs `useSafeSearch` to drive
 * the URL, which is the right way to test what the hook DECIDES — and is
 * exactly why it could not catch this: stubbing the router seam is stubbing
 * away the crash. So this file deliberately mocks nothing. The real
 * `useSessionSearch` → `useSafeSearch` → TanStack chain runs, with no provider
 * above it.
 *
 * That chain used to throw `Cannot read properties of null (reading 'stores')`.
 * `useTaskState` picked the hook up in DOR-1444, and five DOR-1441 tests that
 * had legitimately never needed a router went red in the merge queue. The
 * failing tests were the tripwire; the bug is that a hook every session surface
 * calls could not survive a tree without a router.
 *
 * Kept as its own file for one reason: the moment anything here is mocked, or a
 * router wrapper is added, it stops testing what it exists to test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';
import { useSessionScopedCwd, isSessionScopeReady } from '../use-session-scoped-cwd';

beforeEach(() => {
  useAppStore.setState({ selectedCwd: null });
});

describe('useSessionScopedCwd without a RouterProvider', () => {
  it('answers instead of throwing', () => {
    // Red when the router read is unguarded: this line throws rather than
    // returning, and every test that mounts a session hook without a router
    // fails with it.
    const { result } = renderHook(() => useSessionScopedCwd());

    expect(result.current).toEqual({ cwd: null, resolved: true });
    expect(isSessionScopeReady('s1', result.current)).toBe(true);
  });

  it('still refuses to substitute the store default', () => {
    // The DOR-1444 property has to survive the router-less path too, or the
    // fix for the crash would quietly reintroduce the bug it was fixing.
    useAppStore.setState({ selectedCwd: '/server/default' });

    const { result } = renderHook(() => useSessionScopedCwd());

    expect(result.current.cwd).toBeNull();
  });
});
