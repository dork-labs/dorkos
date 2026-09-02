/**
 * The task form's target-agent row: who this task runs as, and — on an edit —
 * why that can no longer change.
 *
 * @module features/tasks/ui/TaskAgentField
 */
import { Label } from '@/layers/shared/ui';
import { AgentPicker } from './AgentPicker';
import type { AgentPick } from './use-agent-pick';

/**
 * The sentence the inert picker points at on an edit.
 *
 * A constant rather than a literal in two places, because the picker's
 * `aria-describedby` and the paragraph's `id` have to be the same string or the
 * explanation is never read out with the control it explains.
 */
const AGENT_LOCKED_NOTE_ID = 'schedule-agent-locked';

/** What {@link TaskAgentField} draws. */
export interface TaskAgentFieldProps {
  /** The agents this machine can file a task against. */
  agents: Array<{ id: string; name: string; projectPath: string; icon?: string; color?: string }>;
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
 * Choose which agent a new task runs as, or read which one an existing task
 * already does.
 *
 * @param props - The roster, the current pick, and whether the choice is
 *   settled; see {@link TaskAgentFieldProps}.
 */
export function TaskAgentField({ agents, value, locked, pick }: TaskAgentFieldProps) {
  return (
    <div className="space-y-2">
      <Label>Agent</Label>
      <AgentPicker
        agents={agents}
        value={value || undefined}
        {...(locked ? { disabledReasonId: AGENT_LOCKED_NOTE_ID } : {})}
        // Picking an agent moves the runtime this task INHERITS, and a mode id
        // means whatever the runtime running it says it means — so this is the
        // runtime picker's widening reached by a different road (DOR-1637).
        // Same door, same rule, and the candidate's runtime is resolved BEFORE
        // the pick commits.
        onValueChange={(id) => pick.pick(id ?? '')}
      />
      {locked ? (
        <p
          id={AGENT_LOCKED_NOTE_ID}
          data-testid="agent-locked-note"
          className="text-muted-foreground text-xs leading-relaxed"
        >
          You can’t change the agent after a task is created. To run this work as a different agent,
          create a new task.
        </p>
      ) : (
        /* Said out loud, because the alternative is a click that appears to do
           nothing. The agent is unchanged in both cases; what differs is
           whether waiting will fix it, so each says which. */
        (pick.isWaiting || pick.wasDropped) && (
          <p
            data-testid="agent-pick-waiting"
            className="text-muted-foreground text-xs leading-relaxed"
          >
            {pick.wasDropped
              ? 'DorkOS couldn’t read what that agent runs on, so the agent hasn’t been changed. Choose it again to retry.'
              : 'Checking what that agent runs on…'}
          </p>
        )
      )}
    </div>
  );
}
