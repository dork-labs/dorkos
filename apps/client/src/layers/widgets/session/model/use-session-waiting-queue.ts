import { useMemo } from 'react';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { useSessionQueue, useSessionStreamLifecycle } from '@/layers/entities/session';
import { useAgentPause } from '@/layers/entities/mesh';
import { selectWaitingQueue } from '@/layers/features/chat';

/** The session's queue as the server holds it, and the part a person sees waiting. */
export interface SessionWaitingQueue {
  /** Every queued message, head first. */
  serverQueue: QueuedMessage[];
  /** The session's server-held lifecycle, `undefined` before hydration. */
  lifecycle: SessionLifecycle | undefined;
  /** The messages genuinely waiting (see `selectWaitingQueue`). */
  waiting: QueuedMessage[];
  /** The session's agent is paused, so the server holds its queue (DOR-4348). */
  agentPaused: boolean;
}

/**
 * Read a session's queue and narrow it to what is genuinely waiting.
 *
 * @param sessionId - The session, or `''` when none is selected
 * @param agentId - The session's agent, whose pause holds the queue
 */
export function useSessionWaitingQueue(
  sessionId: string,
  agentId: string | null
): SessionWaitingQueue {
  const serverQueue = useSessionQueue(sessionId);
  const lifecycle = useSessionStreamLifecycle(sessionId);
  const agentPaused = useAgentPause(agentId) !== null;
  const waiting = useMemo(
    () => selectWaitingQueue(serverQueue, lifecycle, { agentPaused }),
    [serverQueue, lifecycle, agentPaused]
  );
  return { serverQueue, lifecycle, waiting, agentPaused };
}
