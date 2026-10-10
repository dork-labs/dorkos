/**
 * The notice under the transcript when a message could not be sent: the
 * paused-agent notice with its Resume, or the plain transport error block.
 *
 * @module widgets/session/ui/SessionErrorNotice
 */
import { AGENT_PAUSED_CODE, type AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { TransportErrorInfo } from '@/layers/shared/model';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { AgentPausedNotice } from '@/layers/entities/mesh';
import { ErrorMessageBlock } from '@/layers/features/chat';

interface SessionErrorNoticeProps {
  /** The session's transport error. */
  error: TransportErrorInfo;
  /** The agent that owns the composer's folder, when one does. */
  composerAgent: AgentManifest | null | undefined;
  /** Retries the failed send; offered only when the error is retryable. */
  onRetry: () => void;
}

/**
 * Renders the transport error for a session. A paused agent is a choice
 * somebody made, not a failure: it says who is paused and offers Resume where
 * the message failed (spec `audit-trail` PR5).
 */
export function SessionErrorNotice({ error, composerAgent, onRetry }: SessionErrorNoticeProps) {
  // A pause naming no agent has nothing to resume, so it shows as a plain error.
  if (error.code === AGENT_PAUSED_CODE && error.agentId) {
    return (
      <div className="mx-4 mb-2">
        <AgentPausedNotice
          agentId={error.agentId}
          {...(composerAgent?.id === error.agentId
            ? { agentName: getAgentDisplayName(composerAgent, 'This agent') }
            : {})}
        />
      </div>
    );
  }
  return (
    <div className="mx-4 mb-2">
      <ErrorMessageBlock
        message={error.message}
        heading={error.heading}
        subtext={error.message}
        onRetry={error.retryable ? onRetry : undefined}
      />
    </div>
  );
}
