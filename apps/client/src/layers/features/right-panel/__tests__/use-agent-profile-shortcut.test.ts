/**
 * @vitest-environment jsdom
 *
 * ⌘⇧A / Ctrl+Shift+A — the profile's key (spec `profile-unification` §1.6).
 *
 * The binding is unchanged; what it opens is not. The tab it names was renamed
 * from `agent-hub` to `profile`, and a shortcut still asking for the old id
 * would open a tab that no longer exists — the panel would fall back to
 * whatever is first, which is not what the key promises.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';
import { useAgentProfileShortcut } from '../model/use-agent-profile-shortcut';

/** Press the shortcut the way a keyboard does. */
function press() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'A', metaKey: true, shiftKey: true, bubbles: true })
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    rightPanelOpen: false,
    activeRightPanelTab: null,
    rightPanelLayoutKey: null,
  });
});

afterEach(cleanup);

describe('the profile shortcut', () => {
  it('opens the panel on the Profile tab', () => {
    renderHook(() => useAgentProfileShortcut());

    press();

    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });

  it('closes the panel when it is already showing the profile', () => {
    useAppStore.setState({ rightPanelOpen: true, activeRightPanelTab: 'profile' });
    renderHook(() => useAgentProfileShortcut());

    press();

    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('switches to the profile rather than closing, from another tab', () => {
    useAppStore.setState({ rightPanelOpen: true, activeRightPanelTab: 'files' });
    renderHook(() => useAgentProfileShortcut());

    press();

    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });

  it('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => useAgentProfileShortcut());
    unmount();

    press();

    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });
});
