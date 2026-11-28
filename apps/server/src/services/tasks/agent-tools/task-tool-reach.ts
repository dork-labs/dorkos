/**
 * What the tasks tools reach in other domains, handed in through
 * `AgentToolDeps.tasksReach` rather than imported (spec
 * `computer-side-starts-alone` §5.1, C9a).
 *
 * The tools moved from Claude Code's folder into `services/tasks/agent-tools/`.
 * Imported here, these helpers would have added two pairs to the services
 * import boundary and raised five more; handed in, the tools import no other
 * domain by value. The boot step that builds the deps fills it
 * (`startup/task-tool-reach.ts`), and a tasks tool with nothing wired refuses
 * the way a server with Tasks off does (`requireTasks`): unwired is a refusal,
 * never a call that runs without its audit row, its marks or its notices.
 *
 * Types only: every field is the helper's own signature.
 *
 * @module services/tasks/agent-tools/task-tool-reach
 */
import type { AgentToolDeps } from '../../core/agent-tool-kit/agent-tool-kit.js';
import type { recordAudit } from '../../audit/audit-trail.js';
import type { readOperatorTimeZone } from '../../core/config/operator-time-zone.js';
import type { RuntimeRegistry } from '../../core/runtime-registry.js';
import type { marksOf } from '../../core/turn-power/turn-levels.js';
import type { marksHold } from '../../core/turn-power/turn-marks.js';
import type { settleDeclaredTask } from '../../core/turn-power/declared-readers.js';
import type { fenceUntrustedBlock } from '../../core/untrusted-text/untrusted-fence.js';
import type { resolveAgentIdForPath, resolveAgentNameForId } from '../../mesh/agent-path-lookup.js';
import type {
  postScheduleArmed,
  resolveScheduleArmedPayload,
} from '../../notifications/emitters/schedule-armed.js';
import type {
  resolveParkedScheduleRemoved,
  resolveScheduleParkPayload,
} from '../../notifications/emitters/schedule-park.js';
import type { raiseStanding } from '../../notifications/standing-events.js';

/** The helpers the tasks tools call in other domains, each with its own signature. */
export interface TaskToolReach {
  /** Writes one audit row (`audit/audit-trail.ts`). */
  recordAudit: typeof recordAudit;
  /** The person's saved time zone, for a schedule made without one. */
  readOperatorTimeZone: typeof readOperatorTimeZone;
  /** The runtimes this server runs, for which runtime a task's run would use. */
  runtimeRegistry: RuntimeRegistry;
  /** A turn's marks, read by its chat and agent. */
  marksOf: typeof marksOf;
  /** Whether a turn's marks hold its writes for a person. */
  marksHold: typeof marksHold;
  /** Settles what a task declares it reads, after a write. */
  settleDeclaredTask: typeof settleDeclaredTask;
  /** Fences words DorkOS cannot vouch for before a person reads them. */
  fenceUntrustedBlock: typeof fenceUntrustedBlock;
  /** The agent whose folder a path is. */
  resolveAgentIdForPath: typeof resolveAgentIdForPath;
  /** An agent's name, by id. */
  resolveAgentNameForId: typeof resolveAgentNameForId;
  /** The "schedule armed" notice's payload. */
  resolveScheduleArmedPayload: typeof resolveScheduleArmedPayload;
  /** Posts the "schedule armed" notice. */
  postScheduleArmed: typeof postScheduleArmed;
  /** The "schedule parked" notice's payload. */
  resolveScheduleParkPayload: typeof resolveScheduleParkPayload;
  /** Ends a parked schedule's standing notice once the schedule is gone. */
  resolveParkedScheduleRemoved: typeof resolveParkedScheduleRemoved;
  /** Raises a standing notice. */
  raiseStanding: typeof raiseStanding;
  /** What a notice calls an agent DorkOS cannot name. */
  unnamedProposer: string;
}

/**
 * The reach the tasks tools were handed. Only read after `requireTasks` passed,
 * which refuses a call when it is missing.
 *
 * @param deps - The tool dependencies.
 * @throws When nothing is wired, so a path that skipped `requireTasks` refuses too.
 */
export function reachOf(deps: Pick<AgentToolDeps, 'tasksReach'>): TaskToolReach {
  if (!deps.tasksReach) throw new Error('The tasks tools have nothing wired to reach.');
  return deps.tasksReach;
}
