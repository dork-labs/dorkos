import { ChatPanel } from '@/layers/features/chat';
import { useSessionId } from '@/layers/entities/session';

/**
 * Session route page — wraps ChatPanel with route-derived session ID.
 * Identical behavior to the previous root view.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();

  return <ChatPanel sessionId={activeSessionId} />;
}
