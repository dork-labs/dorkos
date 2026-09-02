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
import type { AgentPick } from './use-agent-pick';

/**
 * The agents this machine can file a task against, and whether that list is an
 * ANSWER yet.
 *
 * The flags travel with the list rather than beside it, because a caller
 * flattening the query to `data?.agents ?? []` throws away the difference
 * between "nobody has answered", "the read failed" and "there are none" — and a
 * surface that reads an empty list as an answer then says something false about
 * a healthy task. `AgentRuntimeLookup` splits the same three worlds one file
 * over, for the same reason and with the same two words.
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
   * the trust dial re-captioned to the picked agent's runtime, and its OWN
   * consent gate then asked in that runtime's vocabulary. A task on Codex at
   * `plan`, moved to the Claude Code agent, walked to the middle stop with no
   * door and saved `acceptEdits` — a mode Codex never asks in — onto a task
   * still running on Codex (DOR-1694). A control that cannot do the thing it
   * appears to do is the defect; not appearing to is the fix.
   */
  locked: boolean;
  /**
   * The held-pick state machine that prices a change before it commits.
   *
   * Unused while {@link TaskAgentFieldProps.locked}, and still required: a pick
   * that cannot be made has no state to report, and an optional prop would
   * invite a create form to forget it.
   */
  pick: AgentPick;
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
        DorkOS couldn’t read your list of agents, so it can’t show which one this is.
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
export function TaskAgentField({ roster, value, locked, pick }: TaskAgentFieldProps) {
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
            You can’t change the agent after a task is created. To run this work as a different
            agent, create a new task.
          </p>
        </>
      ) : (
        <>
          <AgentPicker
            agents={roster.agents}
            value={value || undefined}
            // Picking an agent moves the runtime this task INHERITS, and a mode
            // id means whatever the runtime running it says it means — so this
            // is the runtime picker's widening reached by a different road
            // (DOR-1637). Same door, same rule, and the candidate's runtime is
            // resolved BEFORE the pick commits.
            onValueChange={(id) => pick.pick(id ?? '')}
          />
          {/* Said out loud, because the alternative is a click that appears to
              do nothing. The agent is unchanged in both cases; what differs is
              whether waiting will fix it, so each says which. */}
          {(pick.isWaiting || pick.wasDropped) && (
            <p
              data-testid="agent-pick-waiting"
              className="text-muted-foreground text-xs leading-relaxed"
            >
              {pick.wasDropped
                ? 'DorkOS couldn’t read what that agent runs on, so the agent hasn’t been changed. Choose it again to retry.'
                : 'Checking what that agent runs on…'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
