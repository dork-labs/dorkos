import type { ApprovalSubject as ApprovalSubjectValue } from '@dorkos/shared/approval-schemas';
import { cn } from '@/layers/shared/lib';

/** What each kind of subject is called on the card. */
const KIND_LABEL: Record<ApprovalSubjectValue['kind'], string> = {
  agent: 'Agent',
  task: 'Scheduled task',
  room: 'Channel',
  connection: 'Connection',
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
 * A card renders this ABOVE the summary and never instead of it: the summary is
 * still the full sentence, and on a `destructive` card it is deliberately never
 * clamped.
 */
export function ApprovalSubject({ subject, className }: ApprovalSubjectProps) {
  return (
    <div data-slot="approval-subject" className={cn('mt-1 min-w-0', className)}>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-muted-foreground text-2xs shrink-0 uppercase">
          {KIND_LABEL[subject.kind]}
        </span>
        <span className="text-foreground min-w-0 truncate text-sm font-medium">
          {subject.label}
        </span>
      </div>
      {/* `break-all` rather than `truncate`: an id is checked character by
          character or not at all, so wrapping one is right where hiding its tail
          behind an ellipsis is not. */}
      <span className="text-muted-foreground/80 text-2xs block font-mono break-all">
        {subject.id}
      </span>
    </div>
  );
}
