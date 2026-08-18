import { useCallback } from 'react';
import { ChatPanel } from './ChatPanel';
import { useCanvasPersistence } from '@/layers/features/canvas';
import { useRightPanelLayoutPersistence } from '@/layers/features/right-panel';
import { useSessionId, useSessionSearch } from '@/layers/entities/session';
import { useInPlaceNavigate } from '@/layers/shared/model';

/**
 * Session route page — wraps ChatPanel with route-derived session ID.
 *
 * Canvas state (open/closed, content) is persisted per-session in localStorage
 * and hydrated on mount or session change via `useCanvasPersistence`. The
 * canvas panel itself is rendered at the shell level via the extension registry.
 *
 * The right panel's layout (open state + active tab) is persisted per-agent and
 * hydrated on agent change via `useRightPanelLayoutPersistence` (DOR-227), so
 * returning to an agent restores how you left its panel.
 *
 * The `?runtime=` search param (launch-time runtime selection) is forwarded so
 * the session-creating first message carries it as the runtime hint. The
 * `?prompt=` seed and its `?send=1` opt-in are forwarded so a launch link can
 * pre-fill — and optionally start — a freshly-launched session's first turn, and
 * `?seed=dorkbot-help` is the sidebar's Ask DorkBot press, which pre-fills
 * nothing and instead hands the first turn a hidden preamble (BC-48). This page
 * owns the other half of all three contracts: dropping the params from the URL
 * once they are spent.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();
  const { runtime, prompt, send, seed } = useSessionSearch();
  const inPlaceNavigate = useInPlaceNavigate();
  useCanvasPersistence(activeSessionId);
  useRightPanelLayoutPersistence();

  /**
   * Drop the spent launch params, in place and without a history entry.
   *
   * In-place rather than a plain `navigate`: the cockpit is not going anywhere,
   * and the session-navigation guard must not read this rewrite as a departure
   * that abandons a lookup in flight (DOR-928/931). `replace`, because the URL
   * with the launch params in it is not a place anyone should be able to go
   * Back to — that is precisely the re-send this clears.
   */
  const handleLaunchConsumed = useCallback(() => {
    inPlaceNavigate?.({
      search: (prev) => ({ ...prev, prompt: undefined, send: undefined, seed: undefined }),
      replace: true,
    });
  }, [inPlaceNavigate]);

  return (
    <ChatPanel
      sessionId={activeSessionId}
      launchRuntime={runtime}
      launchPrompt={prompt}
      launchSend={send === '1'}
      launchSeed={seed}
      onLaunchConsumed={handleLaunchConsumed}
    />
  );
}
