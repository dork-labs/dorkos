/**
 * What a proposed schedule will run at, and whether approving it can hand it
 * the operator's OWN trust stop instead (DOR-2100).
 *
 * ## The gap this closes
 *
 * An agent that proposes a schedule cannot name its power: `createScheduledTask`
 * clamps every untrusted caller's mode back to `acceptEdits`, and that clamp is
 * load-bearing (DOR-504, DOR-607, DOR-823) — nothing on disk and nothing an
 * agent says may arm an unattended run at full power. But the APPROVAL is a
 * person, and until now it carried `status` and nothing else. So an operator
 * sitting at Full autonomy approved a schedule that then ran at `acceptEdits`
 * and refused its own first shell call, with no screen anywhere naming the
 * level.
 *
 * The grant is therefore offered here: per task, on that task's own card, with
 * the level named on the control. Not a global preference and not a blanket
 * "approve at full autonomy" — either would hand the same power to the next
 * schedule an agent proposes, which is exactly what the clamp exists to stop.
 *
 * ## Nothing is derived twice
 *
 * The stop comes from `operatorStopForRuntime` and is mapped to a mode by
 * `resolveConfiguredStopMode` — the same two functions the task form and the
 * relay binding dialog open at, resolving through `resolveTrustStops`, which is
 * what the dial itself renders from. "Higher" is `isTightening` read backwards,
 * the shared rule, never an ordering of mode ids.
 *
 * ## When no raise is offered
 *
 * Conservative at every unknown: an unregistered runtime, a capability map that
 * has not landed, an operator who never set a stop, a stop this runtime
 * declares no mode at, or a stop that is not ABOVE where the schedule already
 * sits. Each answers `null`, and the card draws the plain Approve alone.
 *
 * ## The raise still meets the consent door
 *
 * Resolving one is not granting one. A mode that never asks is a posture a
 * person agrees to rather than arrives at, and every other surface that can
 * reach one opens `UnattendedAutonomyDialog` first (`use-posture-consent.ts`:
 * "a gate on one path is not a gate"). The card does the same before it sends
 * the PATCH — see {@link ScheduleApprovalCard}. This hook only answers what is
 * available.
 *
 * ## One refusal this cannot see, and why that is right
 *
 * A schedule an installed package owns takes `enabled` on the row alone and
 * nothing else (`file-sync-gates.ts`), because DorkOS will not write into
 * somebody else's checkout. `permissionMode` lives in the file, so a grant
 * written to that row alone would be undone by the next sweep — and
 * `PATCH /api/tasks/:id` answers 409 rather than pretending otherwise. The card
 * has no way to know a file is package-owned before it asks, so the raise is
 * offered and the server's own sentence explains the refusal; the plain Approve
 * beside it still works. A silent half-grant would be the worse answer.
 *
 * @module features/schedule-approval/model/use-schedule-approval-power
 */
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import type { PermissionMode, Task } from '@dorkos/shared/types';
import { useConfig } from '@/layers/entities/config';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCapabilitiesForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import {
  isTightening,
  operatorStopForRuntime,
  resolveConfiguredStopMode,
} from '@/layers/shared/lib';

/** The raise a person may grant this schedule as they approve it. */
export interface ScheduleApprovalRaise {
  /** The mode id to send with the approving PATCH. */
  mode: PermissionMode;
  /** That mode as its runtime declared it — the source of its label and promise. */
  descriptor: PermissionModeDescriptor;
  /** The dial position it sits at, which is what the control names. */
  stop: PermissionStop;
}

/** What the card needs to know about a proposal's power. */
export interface ScheduleApprovalPower {
  /**
   * The mode the schedule runs at if approved as it stands, as its runtime
   * declared it — `null` when no profile is in hand, which is the card's cue to
   * fall back to the mode's id for a label.
   */
  current: PermissionModeDescriptor | null;
  /** The raise on offer, or `null` when there is none to make. */
  raise: ScheduleApprovalRaise | null;
}

/** Nothing known, nothing offered. The answer at every unknown below. */
const NO_POWER: ScheduleApprovalPower = { current: null, raise: null };

/**
 * Resolve what a proposed schedule will run at, and the raise its approval may
 * carry.
 *
 * The runtime is the same ladder the server walks at create time
 * (`resolveCreateRuntime`) and the task form draws from: the task's own
 * override, else its agent's manifest runtime, else the registry default. It
 * matters because a mode id is not portable — mapping the operator's stop
 * through Claude Code's vocabulary for a task filed under a Codex agent would
 * store an id Codex never declared (DOR-1615).
 *
 * @param task - The schedule waiting on a yes or a no.
 * @returns The level it runs at, and the raise on offer; see
 *   {@link ScheduleApprovalPower}.
 */
export function useScheduleApprovalPower(task: Task): ScheduleApprovalPower {
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: config } = useConfig();
  // Only for a task that is filed under one. The query is the same one the
  // Tasks page and the Inbox already hold, so on every surface that draws this
  // card it is a cache read rather than a request.
  const { data: meshAgents } = useRegisteredAgents(undefined, task.agentId !== null);

  const agentRuntime = task.agentId
    ? (meshAgents?.agents.find((agent) => agent.id === task.agentId)?.runtime ?? null)
    : null;
  const runtime = task.runtime ?? agentRuntime ?? capabilityMap?.defaultRuntime ?? null;
  // Unregistered answers `undefined` whatever the string spells — a task's
  // `runtime` is a free string, so `constructor` and `toString` reach here.
  const capabilities = useCapabilitiesForRuntime(runtime);

  const descriptors = capabilities?.permissionModes?.values ?? [];
  const current = descriptors.find((mode) => mode.id === task.permissionMode) ?? null;
  if (runtime === null || current === null) return NO_POWER;

  // Everything from here answers `{ current, raise: null }` rather than
  // {@link NO_POWER}: the level this schedule runs at is known now, and the
  // card still has to name it. Dropping it on the way to "no raise" is how the
  // card fell back to the id-keyed label on every install whose operator never
  // set a stop — which is most of them.
  const stop = operatorStopForRuntime(config?.executionDefaults, runtime);
  if (!stop) return { current, raise: null };

  const mode = resolveConfiguredStopMode(stop, descriptors);
  const descriptor = descriptors.find((candidate) => candidate.id === mode);
  // Three ways this is not a raise, and the middle one is not obvious.
  //
  // - A mode the runtime does not declare cannot be named on a control.
  // - **A mode that does not sit at the stop the operator chose.**
  //   `resolveConfiguredStopMode` answers `'acceptEdits'` when the runtime
  //   declares nothing at that stop — the right fallback for a FORM opening at
  //   a default, and a lie here: the control would read "Approve at Full
  //   autonomy" and grant `acceptEdits`. The stop is what the button names, so
  //   the mode has to actually be at it (adversarial review).
  // - A level that is not ABOVE where the schedule already sits is not a
  //   raise — including the stop BELOW it, which would be an offer to approve
  //   at less.
  if (!descriptor || descriptor.stop !== stop) return { current, raise: null };
  if (!isTightening(descriptor, current)) return { current, raise: null };

  return { current, raise: { mode, descriptor, stop } };
}
