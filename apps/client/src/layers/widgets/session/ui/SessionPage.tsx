import { ChatPanel } from '@/layers/features/chat';
import { useCanvasPersistence } from '@/layers/features/canvas';
import { useSessionId, useSessionSearch } from '@/layers/entities/session';

/**
 * Session route page — wraps ChatPanel with route-derived session ID.
 *
 * Canvas state (open/closed, content) is persisted per-session in localStorage
 * and hydrated on mount or session change via `useCanvasPersistence`. The
 * canvas panel itself is rendered at the shell level via the extension registry.
 *
 * The `?runtime=` search param (launch-time runtime selection) is forwarded so
 * the session-creating first message carries it as the runtime hint. The
 * `?prompt=` seed ("Run this with…") is forwarded so a freshly-launched
 * session's composer is pre-filled with the re-run prompt.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();
  const { runtime, prompt } = useSessionSearch();
  useCanvasPersistence(activeSessionId);

  return <ChatPanel sessionId={activeSessionId} launchRuntime={runtime} launchPrompt={prompt} />;
}
