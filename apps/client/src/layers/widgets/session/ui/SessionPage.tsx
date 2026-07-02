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
 * the session-creating first message carries it as the runtime hint.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();
  const { runtime } = useSessionSearch();
  useCanvasPersistence(activeSessionId);

  return <ChatPanel sessionId={activeSessionId} launchRuntime={runtime} />;
}
