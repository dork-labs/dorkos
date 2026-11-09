import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import type { ApprovalSubject as ApprovalSubjectValue } from '@dorkos/shared/approval-schemas';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { useConnectorAgentRequest } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { cn } from '@/layers/shared/lib';

/** What each kind of subject is called on the card. */
const KIND_LABEL: Record<ApprovalSubjectValue['kind'], string> = {
  agent: 'Agent',
  task: 'Scheduled task',
  room: 'Room',
  agent_request: 'Read request',
};

export interface ApprovalSubjectProps {
  /** The named thing this approval would act on. */
  subject: ApprovalSubjectValue;
  className?: string;
}

/**
 * The thing an approval would act on, named.
 *
 * ## Why the name is big and the id is still here
 *
 * The card this sits in used to say `agentId: "01KXQ3P7ADJY9DSXMZW1XGWCV4"` and
 * nothing else, and a person was asked to approve four irreversible deletions
 * they could not tell apart. The name is the answer to "which one", so it gets
 * the weight of the sentence.
 *
 * The id stays, one line down and quiet. That is not a hedge — it is the only
 * unforgeable half of the pair. Every name here comes from a registry an agent
 * can write to (an agent's `displayName` lives in its own `agent.json`), so an
 * agent that wanted to disguise which agent it was deleting could name itself
 * after another one. Showing only the name would make that attack invisible;
 * showing both makes it checkable. Progressive disclosure means the id is
 * secondary, never that it is absent.
 *
 * One kind goes a step further. On another agent's request (`agent_request`)
 * the name sits beside that agent's own avatar and Bot badge, which is what
 * tells two same-named agents apart, and the request's id moves behind ⓘ: it
 * names a request, not the agent, so it checks nothing a person would read
 * (design ruling on #3572, S6).
 *
 * A card renders this ABOVE the summary and never INSTEAD of it: the summary is
 * still the full sentence, and on a `destructive` card it is deliberately never
 * clamped.
 */
export function ApprovalSubject({ subject, className }: ApprovalSubjectProps) {
  const idBehindInfo = subject.kind === 'agent_request';
  const [showId, setShowId] = useState(false);
  const idSlot = useId();
  return (
    <div data-slot="approval-subject" className={cn('mt-1 min-w-0', className)}>
      {/* Centred only beside an avatar and ⓘ; text alone sits on its baseline. */}
      <div
        className={cn(
          'flex min-w-0 gap-1.5',
          // On a phone a request's kind takes its own line, so the name beside
          // the avatar gets the full width and wraps between words.
          idBehindInfo ? 'items-center max-sm:flex-wrap max-sm:gap-y-1' : 'items-baseline'
        )}
      >
        <span
          className={cn(
            'text-muted-foreground text-2xs shrink-0 uppercase',
            idBehindInfo && 'max-sm:basis-full'
          )}
        >
          {KIND_LABEL[subject.kind]}
        </span>
        {idBehindInfo && <RequesterAvatar requestId={subject.id} />}
        {/* A request's label is who asked and the app, so on a phone it wraps
            rather than cutting off the app; other names keep one line. */}
        <span
          className={cn(
            'text-foreground min-w-0 text-sm font-medium',
            idBehindInfo ? 'break-words max-sm:flex-1 max-sm:basis-0' : 'truncate'
          )}
        >
          {subject.label}
        </span>
        {idBehindInfo && (
          <button
            type="button"
            aria-label="Details"
            aria-expanded={showId}
            aria-controls={idSlot}
            data-slot="approval-subject-details"
            onClick={() => setShowId((shown) => !shown)}
            className="text-muted-foreground hover:text-foreground focus-ring flex size-6 shrink-0 items-center justify-center rounded"
          >
            <Info className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {/* `break-all` rather than `truncate`: an id is checked character by
          character or not at all, so wrapping one is right where hiding its tail
          behind an ellipsis is not. */}
      {(!idBehindInfo || showId) && (
        <span
          id={idSlot}
          data-slot="approval-subject-id"
          className="text-muted-foreground/80 text-2xs block font-mono break-all"
        >
          {subject.id}
        </span>
      )}
    </div>
  );
}

/**
 * The agent that asked, Bot badge and all, read from the person's own view of
 * the request (owner-scoped, unlike the label's lookup) and then the registry.
 * Draws nothing until both answer, so the card never shows a wrong face.
 */
function RequesterAvatar({ requestId }: { requestId: string }) {
  const request = useConnectorAgentRequest(requestId);
  const { data } = useRegisteredAgents();
  const agentId = request.data?.agent.id;
  const agent = agentId ? data?.agents.find((candidate) => candidate.id === agentId) : undefined;
  if (!agent) return null;
  const visual = resolveAgentVisual(agent);
  return (
    <span data-slot="approval-subject-agent" className="shrink-0">
      <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
    </span>
  );
}
