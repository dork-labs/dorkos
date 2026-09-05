/**
 * @vitest-environment jsdom
 *
 * The router-less mount (the Obsidian embed renders `App` directly, with no
 * `RouterProvider`) — see `use-safe-router.ts`.
 *
 * These hooks write the URL, and in the embed there is no URL to write. The
 * hazard is not cosmetic: `useNavigate()` resolves its router lazily, so the
 * hook itself mounts fine and only the *click* throws
 * `Cannot read properties of null (reading 'navigate')` — a CTA that looks
 * healthy until someone presses it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { setPlatformAdapter } from '@/layers/shared/lib/platform';
import { useAppStore } from '../app-store';
import {
  useSettingsDeepLink,
  useTasksDeepLink,
  useProfileDeepLink,
  useOpenConnections,
} from '../use-dialog-deep-link';

const EMBED = { isEmbedded: true, openFile: async () => {} };
const WEB = { isEmbedded: false, openFile: async () => {} };

beforeEach(() => {
  setPlatformAdapter(EMBED);
  useAppStore.setState({
    settingsOpen: false,
    tasksOpen: false,
    profileOpen: false,
    profileMemberId: null,
  });
});

afterEach(() => {
  setPlatformAdapter(WEB);
});

describe('dialog deep links in a router-less mount', () => {
  it('a Settings CTA opens the dialog instead of throwing', () => {
    const { result } = renderHook(() => useSettingsDeepLink());

    // Before the guard this threw: `useNavigate()` had no router to resolve.
    act(() => result.current.open('runtimes'));

    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it('closing a Settings dialog opened this way actually closes it', () => {
    const { result } = renderHook(() => useSettingsDeepLink());
    act(() => result.current.open('runtimes'));

    act(() => result.current.close());

    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it('setTab and setSection are inert rather than fatal', () => {
    const { result } = renderHook(() => useSettingsDeepLink());

    expect(() => {
      act(() => result.current.setTab('advanced'));
      act(() => result.current.setSection('mcp'));
    }).not.toThrow();
  });

  it('the Tasks dialog falls back to the store flag', () => {
    const tasks = renderHook(() => useTasksDeepLink());

    act(() => tasks.result.current.open());
    expect(useAppStore.getState().tasksOpen).toBe(true);

    act(() => tasks.result.current.close());
    expect(useAppStore.getState().tasksOpen).toBe(false);
  });

  it('a profile opens on the store half, subject and all', () => {
    // There is no URL to carry the subject in the embed, so the store carries
    // it instead — otherwise the drawer would open on nobody.
    const { result } = renderHook(() => useProfileDeepLink());

    act(() => result.current.open('agent-warden'));

    expect(useAppStore.getState().profileOpen).toBe(true);
    expect(result.current.memberId).toBe('agent-warden');
  });

  it('closing a profile opened this way actually closes it', () => {
    const { result } = renderHook(() => useProfileDeepLink());
    act(() => result.current.open('agent-warden'));

    act(() => result.current.close());

    expect(useAppStore.getState().profileOpen).toBe(false);
    expect(result.current.memberId).toBeNull();
  });

  it('opening Connections does nothing rather than pretending', () => {
    // There is no URL to navigate and no dialog left to fall back to, so the
    // honest embed behaviour is a no-op — not a thrown error, and not a flag
    // that opens something which no longer exists.
    const { result } = renderHook(() => useOpenConnections());
    expect(() => act(() => result.current('messaging'))).not.toThrow();
  });
});
