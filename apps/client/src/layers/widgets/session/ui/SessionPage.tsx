import { ChatPanel } from '@/layers/features/chat';
import { useCanvasPersistence } from '@/layers/features/canvas';
import { useSessionId } from '@/layers/entities/session';

/**
 * Session route page — wraps ChatPanel with route-derived session ID.
 *
 * Canvas state (open/closed, content) is persisted per-session in localStorage
 * and hydrated on mount or session change via `useCanvasPersistence`. The
 * canvas panel itself is rendered at the shell level via the extension registry.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();
  useCanvasPersistence(activeSessionId);

  return <ChatPanel sessionId={activeSessionId} />;
}
