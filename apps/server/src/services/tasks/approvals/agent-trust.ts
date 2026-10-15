/**
 * Whether a schedule one of our agents writes is armed without asking a person
 * (ADR 261006-225605, spec `trusted-by-default-flip` §5.4).
 *
 * Two facts decide it, and both have to hold:
 *
 * - **The install is Trusted** (`trustPosture`). A person who picked Careful
 *   gets every agent schedule parked for approval, as before.
 * - **The server knows the caller is one of our agents**: an in-session tool
 *   call, or a request carrying a registered agent's verified token. An
 *   unidentified caller, a per-user key or the static `MCP_API_KEY` is not
 *   one of ours, and outsiders seed no power, so their schedules still park.
 *
 * This decides arming only. What a schedule may do when it runs is unchanged:
 * an agent still cannot name `permissionMode` or `status`
 * (`task-write-policy.ts`), and schedules found in files, Shapes or packages
 * park whatever the posture.
 *
 * @module services/tasks/approvals/agent-trust
 */
import { trustPosture } from '@dorkos/shared/permissions';
import { configManager } from '../../core/config-manager.js';

/**
 * Whether this agent caller's schedule writes arm without a person.
 *
 * Read at call time, so a person switching to Careful takes effect on the very
 * next write.
 *
 * @param callerIsOurAgent - Whether the server identified the caller as one of
 *   this install's agents (never read from a request body).
 */
export function agentSchedulesArmWithoutAsking(callerIsOurAgent: boolean): boolean {
  if (!callerIsOurAgent) return false;
  // `configManager` is unset only before boot initializes it; a preset nobody
  // could read is a preset not chosen, which is Trusted, as on a fresh install.
  return trustPosture(configManager?.get('permissions')?.preset) === 'trusted';
}
