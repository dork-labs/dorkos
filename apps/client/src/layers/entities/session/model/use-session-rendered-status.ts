/**
 * Subscribe to a session's coarse rendered status without holding its whole
 * projection.
 *
 * The chat renderer already has the projection in hand and calls
 * `selectRenderedStatus` directly. A surface that only wants the answer — the
 * Session readout — subscribes to the three fields the answer depends on, so it
 * does not re-render on every message. Both paths resolve through the same
 * `renderedStatusFrom`, so they cannot disagree.
 *
 * @module entities/session/model/use-session-rendered-status
 */
import type { ChatStatus } from '@/layers/shared/model';
import { renderedStatusFrom } from '../lib/select-rendered-status';
import { useSessionChatStatus } from './session-chat-store';
import { useSessionStreamLifecycle, useSessionTriggerPending } from './session-stream-store';

/**
 * The coarse status this client would render for a session.
 *
 * @param sessionId - Session id, or `''` when no session is active.
 */
export function useSessionRenderedStatus(sessionId: string): ChatStatus {
  const lifecycle = useSessionStreamLifecycle(sessionId);
  const triggerPending = useSessionTriggerPending(sessionId);
  const legacyStatus = useSessionChatStatus(sessionId);
  return renderedStatusFrom(lifecycle, triggerPending, legacyStatus);
}
