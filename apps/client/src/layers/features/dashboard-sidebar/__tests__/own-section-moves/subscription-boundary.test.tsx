// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, waitFor, within } from '@testing-library/react';
import { FixtureSocket, mountSidebar } from './fixture';

beforeEach(() => vi.stubGlobal('WebSocket', FixtureSocket));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('own section moves across the real sidebar subscription boundary', () => {
  it('applies an accepted own move with default query notifications', async () => {
    const sidebar = await mountSidebar();
    try {
      sidebar.enter();
      await sidebar.startOwnMove();
      await sidebar.accept();
      await waitFor(() =>
        expect(within(sidebar.section('group:chosen')).getByText('fixture-channel')).toBeVisible()
      );
      expect(sidebar.channelCopies()).toBe(0);
      expect(within(sidebar.section('channels')).getByText('companion')).toBeVisible();
    } finally {
      sidebar.dispose();
    }
  });

  it('applies an accepted own move after a child-local focus event precedes default notifications', async () => {
    const sidebar = await mountSidebar();
    try {
      sidebar.enter();
      sidebar.armFocus();
      sidebar.nativeClick();
      await waitFor(() => expect(sidebar.transport.updateConfig).toHaveBeenCalledTimes(1));
      expect(sidebar.optimisticItems()).toEqual([{ kind: 'room', roomId: 'fixture-channel' }]);
      expect(sidebar.focusTrigger()).toEqual({ dispatches: 1, retained: true });
      await sidebar.accept();
      expect(within(sidebar.section('channels')).getByText('companion')).toBeVisible();
      // Wait for the real rendered result, not a timer flush or a model supplied by the test.
      await waitFor(() => {
        const placed = within(sidebar.section('group:chosen')).queryByText('fixture-channel');
        expect(placed).not.toBeNull();
        expect(placed).toBeVisible();
      });
      expect(sidebar.channelCopies()).toBe(0);
    } finally {
      sidebar.dispose();
    }
  });

  it('holds an automatic move inside, shows current data, and releases on leave', async () => {
    const sidebar = await mountSidebar();
    try {
      sidebar.enter();
      sidebar.focusInside();
      await sidebar.changeAgent();
      await waitFor(() =>
        expect(
          within(sidebar.section('group:codex')).getByText('Updated fixture agent')
        ).toBeVisible()
      );
      expect(within(sidebar.section('dms')).queryByText('Updated fixture agent')).toBeNull();
      sidebar.leave();
      await waitFor(() =>
        expect(within(sidebar.section('dms')).getByText('Updated fixture agent')).toBeVisible()
      );
      expect(
        within(sidebar.section('group:codex')).queryByText('Updated fixture agent')
      ).toBeNull();
    } finally {
      sidebar.dispose();
    }
  });
});
