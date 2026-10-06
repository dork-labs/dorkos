/**
 * Whether an agent's owner has blocked it from asking for its own conversation
 * to be summarized (DOR-2732), answered outside a tool call.
 *
 * The capability gate inside `registry.invoke` decides the CALL. Two other
 * moments need the same answer and have no call to ride: the summary actually
 * starting, which can be long after the call (the owner may have set Blocked in
 * between), and the `<context_warning>` note, which must not point an agent at
 * a tool it is not allowed to use. Both ask here, through the same sources and
 * the same resolver the gate uses, so the three answers cannot disagree.
 *
 * Blocked is the only answer that stops anything. An Ask was already answered
 * by a person when the call went through, and the warning only names a tool;
 * calling it raises the card as usual.
 *
 * @module services/session/agent-compaction/compaction-permission
 */
import { resolvePermission, type AgentPermissions } from '@dorkos/shared/permissions';
import { homeOf, resolveAgentHome } from '../../core/agent-identity/index.js';
import { permissionGateSources } from '../../core/capabilities/permission-enforcement.js';
import { SESSION_COMPACT_CAPABILITY_ID } from './compaction-capabilities.js';

/**
 * Whether the agent at `agentPath` is blocked from asking for a summary.
 *
 * Fails closed, as the gate does: a config or manifest that cannot be read is
 * treated as Blocked.
 *
 * @param agentPath - The agent's home, or `undefined` for a session that is not
 *   an agent, which resolves against the install's defaults.
 */
export async function isCompactionBlocked(agentPath: string | undefined): Promise<boolean> {
  const sources = permissionGateSources();
  let agent: AgentPermissions | undefined;
  try {
    agent = agentPath ? await sources.readAgentPermissions(agentPath) : undefined;
    const resolved = resolvePermission({
      area: 'own_chat',
      actionId: SESSION_COMPACT_CAPABILITY_ID,
      tier: 'act',
      config: sources.readConfig(),
      ...(agent ? { agent } : {}),
    });
    return resolved.state === 'blocked';
  } catch {
    return true;
  }
}

/**
 * The agent a turn runs as, from its folder and the agent it was dispatched
 * for — the same resolution the runtimes use for identity.
 *
 * @param cwd - The turn's working directory.
 * @param forAgent - The agent the turn was dispatched as, when one was named.
 */
export function agentPathOfTurn(
  cwd: string | undefined,
  forAgent: string | undefined
): string | undefined {
  return homeOf(resolveAgentHome(cwd, forAgent));
}
