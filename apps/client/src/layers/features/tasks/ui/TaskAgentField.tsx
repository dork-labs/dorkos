/**
 * The task form's target-agent row: who this task runs as, and — on an edit —
 * why that can no longer change.
 *
 * @module features/tasks/ui/TaskAgentField
 */
import { Label, Skeleton } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { AgentPicker } from './AgentPicker';

/**
 * The agents this machine can file a task against, and whether that list is an
 * ANSWER yet.
 *
 * The flags travel with the list rather than beside it, because a caller
 * flattening the query to `data?.agents ?? []` throws away the difference
 * between "nobody has answered", "the read failed" and "there are none" — and a
 * surface that reads an empty list as an answer then says something false about
 * a healthy task.
 */
export interface TaskAgentRoster {
  /** The agents this machine knows about — empty until {@link TaskAgentRoster.answered}. */
  agents: AgentPathEntry[];
  /**
   * Whether the roster has been read at all.
   *
   * `false` is **not** "there are no agents": it is "nobody has answered yet",
   * and the two only look alike to a caller that does not care.
   */
  answered: boolean;
  /**
   * Whether the read failed, so waiting longer will not answer it.
   *
   * Told apart from "still in flight" because they need different words on
   * screen: one resolves itself, the other does not.
   */
  unreadable: boolean;
}

/** What {@link TaskAgentField} draws. */
export interface TaskAgentFieldProps {
  /** The roster, and whether it has answered; see {@link TaskAgentRoster}. */
  roster: TaskAgentRoster;
  /** The agent id the form holds right now; `''` for none. */
  value: string;
  /**
   * Whether the choice is already settled, which it is on every EDIT.
   *
   * `UpdateTaskRequestSchema` carries no target at all and the form's edit
   * branch sends none, so a pick there could never change what runs. It only
   * LOOKED like it did, and everything downstream priced against that phantom:
   * the trust dial re-captioned to the picked agent's runtime, so a task on
   * Codex at `plan`, moved to the Claude Code agent, could save `acceptEdits` —
   * a mode Codex never asks in — onto a task still running on Codex (DOR-1694). A control that cannot do the thing it
   * appears to do is the defect; not appearing to is the fix.
   */
  locked: boolean;
  /**
   * Choose an agent: its id, or `''` for none. Unused while
   * {@link TaskAgentFieldProps.locked}.
   */
  onChange: (agentId: string) => void;
}

/**
 * Which agent a task already runs as, drawn as text rather than as a control.
 *
 * Not a disabled picker. A settled choice has no control to disable, and every
 * shape that keeps one — an `aria-disabled` button, a greyed select — hands a
 * keyboard user something to land on that does nothing, and hands the next
 * author a live picker's props (`open`, `onClick`, an agent list) with nothing
 * to do. There is no click to neutralise here because there is no button.
 *
 * The four things this can honestly say are four different states, and the
 * roster's own {@link TaskAgentRoster.answered} is what separates them. Reading
 * an unanswered roster as an answer is how a healthy task gets told its agent is
 * gone: on a cold open for the whole in-flight window, and for good on a read
 * that failed.
 *
 * @param props - The stored agent id and the roster to resolve it against.
 * @internal Rendered only by {@link TaskAgentField}.
 */
function SettledAgent({ roster, value }: { roster: TaskAgentRoster; value: string }) {
  const row = 'flex h-9 w-full items-center gap-2 text-sm';
  // The id is on the TASK, so it is known before any roster is: a task with no
  // agent can be reported at once, and the states below are only ever about
  // resolving an id that is definitely there.
  if (!value) {
    return (
      <p data-testid="settled-agent" className={`${row} text-muted-foreground`}>
        No agent
      </p>
    );
  }
  if (roster.unreadable) {
    return (
      <p data-testid="settled-agent" className={`${row} text-muted-foreground`}>
        Couldn’t load your agents to show this one.
      </p>
    );
  }
  if (!roster.answered) {
    // No sentence at all while the read is in flight. Every sentence available
    // here would be a claim about an agent nobody has looked up yet.
    return (
      <div data-testid="settled-agent-loading" className={row} aria-hidden>
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }
  const agent = roster.agents.find((a) => a.id === value);
  if (!agent) {
    return (
      <p data-testid="settled-agent" className={`${row} text-muted-foreground`}>
        This agent isn’t registered any more.
      </p>
    );
  }
  const visual = resolveAgentVisual(agent);
  return (
    <p data-testid="settled-agent" className={row}>
      <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
      <span className="truncate">{getAgentDisplayName(agent)}</span>
    </p>
  );
}

/**
 * Choose which agent a new task runs as, or read which one an existing task
 * already does.
 *
 * @param props - The roster, the current pick, and whether the choice is
 *   settled; see {@link TaskAgentFieldProps}.
 */
export function TaskAgentField({ roster, value, locked, onChange }: TaskAgentFieldProps) {
  return (
    <div className="space-y-2">
      <Label>Agent</Label>
      {locked ? (
        <>
          <SettledAgent roster={roster} value={value} />
          <p
            data-testid="agent-locked-note"
            className="text-muted-foreground text-xs leading-relaxed"
          >
            The agent is set once. For another agent, make a new task.
          </p>
        </>
      ) : (
        <AgentPicker
          agents={roster.agents}
          value={value || undefined}
          onValueChange={(id) => onChange(id ?? '')}
        />
      )}
    </div>
  );
}
