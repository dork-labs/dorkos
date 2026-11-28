/**
 * The live helpers the tasks tools reach in other domains, built where the
 * tool deps are built (`AgentToolDeps.tasksReach`, C9a). Boot code may import
 * every domain; `services/tasks/agent-tools/` does not, so it is handed these.
 *
 * Each helper is read from its module at call time, as the tools' own imports
 * were, so a test that spies on one still sees the tools call it.
 *
 * @module startup/task-tool-reach
 */
import * as auditTrail from '../services/audit/audit-trail.js';
import * as operatorTimeZone from '../services/core/config/operator-time-zone.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import * as turnLevels from '../services/core/turn-power/turn-levels.js';
import * as turnMarks from '../services/core/turn-power/turn-marks.js';
import * as declaredReaders from '../services/core/turn-power/declared-readers.js';
import * as untrustedFence from '../services/core/untrusted-text/untrusted-fence.js';
import * as agentPathLookup from '../services/mesh/agent-path-lookup.js';
import * as scheduleArmed from '../services/notifications/emitters/schedule-armed.js';
import * as schedulePark from '../services/notifications/emitters/schedule-park.js';
import * as standingEvents from '../services/notifications/standing-events.js';
import type { TaskToolReach } from '../services/tasks/agent-tools/task-tool-reach.js';

/** The tasks tools' reach, over this process's live services. */
export function createTaskToolReach(): TaskToolReach {
  return {
    recordAudit: (input) => auditTrail.recordAudit(input),
    readOperatorTimeZone: () => operatorTimeZone.readOperatorTimeZone(),
    runtimeRegistry,
    marksOf: (...args) => turnLevels.marksOf(...args),
    marksHold: (marks) => turnMarks.marksHold(marks),
    settleDeclaredTask: (...args) => declaredReaders.settleDeclaredTask(...args),
    fenceUntrustedBlock: (...args) => untrustedFence.fenceUntrustedBlock(...args),
    resolveAgentIdForPath: (cwd) => agentPathLookup.resolveAgentIdForPath(cwd),
    resolveAgentNameForId: (id) => agentPathLookup.resolveAgentNameForId(id),
    resolveScheduleArmedPayload: (...args) => scheduleArmed.resolveScheduleArmedPayload(...args),
    postScheduleArmed: (...args) => scheduleArmed.postScheduleArmed(...args),
    resolveScheduleParkPayload: (...args) => schedulePark.resolveScheduleParkPayload(...args),
    resolveParkedScheduleRemoved: (task) => schedulePark.resolveParkedScheduleRemoved(task),
    raiseStanding: ((...args: Parameters<typeof standingEvents.raiseStanding>) =>
      standingEvents.raiseStanding(...args)) as typeof standingEvents.raiseStanding,
    unnamedProposer: schedulePark.UNNAMED_PROPOSER,
  };
}
