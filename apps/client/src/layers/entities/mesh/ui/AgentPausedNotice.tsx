/**
 * What the composer shows when a message could not go because its agent is
 * paused everywhere (spec `audit-trail` PR5): who is paused, and a Resume
 * button right where the message failed.
 *
 * A notice, not an error card: nothing broke. Somebody chose to pause the
 * agent, and the audit log names who. It goes away by itself once the agent is
 * no longer paused, whoever lifted the pause and wherever.
 *
 * @module entities/mesh/ui/AgentPausedNotice
 */
import { useEffect, useState } from 'react';
import { Pause } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/layers/shared/ui';
import { useAgentPauses, useResumeAgent } from '../model/use-agent-pauses';

export interface AgentPausedNoticeProps {
  /** The paused agent's mesh id. */
  agentId: string;
  /** Its name, for the heading; "This agent" when it is not known. */
  agentName?: string;
  /**
   * The person's own queued message is held by the pause (DOR-4348): say it
   * waits in the composer, and name the agent on the button. Resume does not
   * send it; the person's next Send does.
   */
  held?: boolean;
  /** Called once this notice's Resume lifted the pause. */
  onResumed?: () => void;
}

/** The paused-agent notice with its Resume button. */
export function AgentPausedNotice({ agentId, agentName, held, onResumed }: AgentPausedNoticeProps) {
  const resume = useResumeAgent();
  const { data, dataUpdatedAt, refetch } = useAgentPauses();
  const [shownAt] = useState(() => Date.now());
  // The refusal is the newest news; read the list again so a cached answer from
  // before the pause cannot hide this notice.
  useEffect(() => {
    void refetch();
  }, [agentId, refetch]);
  const name = agentName ?? 'This agent';
  // Lifted since the message failed, here or anywhere else: nothing to say.
  const lifted =
    data != null &&
    dataUpdatedAt >= shownAt &&
    !data.pauses.some((pause) => pause.agentId === agentId);
  if (lifted) return null;

  return (
    <div
      data-testid="agent-paused-notice"
      role="status"
      className="border-border bg-muted/50 my-2 flex items-center gap-3 rounded-lg border px-4 py-3"
    >
      <Pause className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{held ? `${name} is paused.` : `${name} is paused`}</p>
        <p className="text-muted-foreground text-xs">
          {held
            ? 'Your message waits here until you resume it and press Send.'
            : 'Resume it, then send your message again.'}
        </p>
      </div>
      <Button
        size="sm"
        variant={held ? 'default' : 'outline'}
        disabled={resume.isPending}
        onClick={() =>
          resume.mutate(agentId, {
            onSuccess: () => {
              toast(`${name} resumed`);
              onResumed?.();
            },
          })
        }
      >
        {held && agentName ? `Resume ${agentName}` : 'Resume'}
      </Button>
    </div>
  );
}
