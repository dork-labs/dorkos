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

import { setPlatformAdapter } from '@/layers/shared/lib';
import { useAppStore } from '../app-store';
import { useSettingsDeepLink, useTasksDeepLink, useRelayDeepLink } from '../use-dialog-deep-link';

const EMBED = { isEmbedded: true, openFile: async () => {} };
const WEB = { isEmbedded: false, openFile: async () => {} };

beforeEach(() => {
  setPlatformAdapter(EMBED);
  useAppStore.setState({ settingsOpen: false, tasksOpen: false, relayOpen: false });
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

  it('the Tasks and Relay dialogs degrade the same way', () => {
    const tasks = renderHook(() => useTasksDeepLink());
    const relay = renderHook(() => useRelayDeepLink());

    act(() => tasks.result.current.open());
    act(() => relay.result.current.open());
    expect(useAppStore.getState().tasksOpen).toBe(true);
    expect(useAppStore.getState().relayOpen).toBe(true);

    act(() => tasks.result.current.close());
    act(() => relay.result.current.close());
    expect(useAppStore.getState().tasksOpen).toBe(false);
    expect(useAppStore.getState().relayOpen).toBe(false);
  });
});
