/**
 * The two quiet lines a DM draws under a reply instead of its work (DOR-3075):
 * "Worked · 6 steps · 1m 12s" with Show work once it is done, and what the
 * agent is doing, with Watch, while it works.
 *
 * @module widgets/session/ui/work/WorkLines
 */
import { Eye } from 'lucide-react';
import { activityVerb } from '@/layers/shared/lib';
import { useSessionToolActivity } from '@/layers/entities/session';
import { openWorkPanel } from '../../model/work-panel-focus';

const LINE = 'text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs';
const ACTION =
  'focus-ring hover:text-foreground inline-flex items-center gap-1 rounded-sm font-medium transition-colors';

/** What the finished line says. */
export interface WorkedLineProps {
  /** The session behind the chat. */
  sessionId: string;
  /** The reply, whose turn Show work opens. */
  messageId: string;
  /** How many steps the reply took. */
  steps: number;
  /** How long its turn took, already worded, or `null` when unknown. */
  duration: string | null;
}

/**
 * `Worked · 6 steps · 1m 12s`, and Show work, which opens this turn in the
 * Work tab. Thinking, tools and todos are all behind it.
 *
 * @param props - See {@link WorkedLineProps}.
 */
export function WorkedLine({ sessionId, messageId, steps, duration }: WorkedLineProps) {
  const words = ['Worked'];
  if (steps > 0) words.push(`${steps} ${steps === 1 ? 'step' : 'steps'}`);
  if (duration) words.push(duration);
  return (
    <div className={LINE} data-testid="dm-worked-line">
      <span>{words.join(' · ')}</span>
      <button type="button" className={ACTION} onClick={() => openWorkPanel(sessionId, messageId)}>
        <Eye className="size-3.5" aria-hidden />
        Show work
      </button>
    </div>
  );
}

/**
 * What the agent is doing right now, in plain words, where its reply will
 * land, and Watch, which opens the live turn in the Work tab.
 *
 * @param props.sessionId - The session behind the chat.
 */
export function WorkingLine({ sessionId }: { sessionId: string }) {
  const activity = useSessionToolActivity(sessionId);
  return (
    <div className={LINE} data-testid="dm-working-line">
      <span className="flex items-center gap-1.5">
        <span className="bg-primary size-1.5 shrink-0 rounded-full motion-safe:animate-pulse" />
        {activityVerb('streaming', activity)}
      </span>
      <button type="button" className={ACTION} onClick={() => openWorkPanel(sessionId, 'live')}>
        Watch
      </button>
    </div>
  );
}
