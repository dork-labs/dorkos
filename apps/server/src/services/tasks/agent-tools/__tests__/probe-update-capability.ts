/**
 * `tasks_update` with a recorder behind it: the real capability's gate, input
 * and escalator in front (C9a), and a handler that only notes what reached it.
 * The escalator reads the test's own sources.
 *
 * @module services/tasks/agent-tools/__tests__/probe-update-capability
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MeshCore } from '@dorkos/mesh';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { composeRegistry } from '../../../core/capabilities/registry.js';
import { invokeCapabilityAsMcpResult } from '../../../core/capabilities/mcp-projection.js';
import type { CapabilityDefinition } from '../../../core/capabilities/capability-definition.js';
import type { AgentModeSources } from '../../agent-mode/agent-mode-decision.js';
import { agentModeEscalators } from '../../agent-mode/agent-mode-escalation.js';
import type { TaskStore } from '../../task-store.js';
import { tasksAgentToolsDomain } from '../task-agent-capabilities.js';

/** Who calls the probe, and over which server. */
export interface ProbeCaller {
  identity?: AgentIdentity;
  sessionId?: string;
  cwd?: string;
  mcpServer: 'in-session' | 'external';
}

/**
 * A registry holding only the probe, and a way to call it.
 *
 * @param opts - The store, Mesh and sources the escalator reads, and where to record calls.
 */
export function probeUpdate(opts: {
  store: Pick<TaskStore, 'getTask' | 'approvals' | 'resolveTaskOrigins'>;
  meshCore?: Pick<MeshCore, 'getProjectPath'>;
  sources: AgentModeSources;
  reached: unknown[];
}): (caller: ProbeCaller, args: Record<string, unknown>) => Promise<CallToolResult> {
  const real = tasksAgentToolsDomain.capabilities.find((c) => c.id === 'tasks.update_task')!;
  const escalators = agentModeEscalators(
    { store: opts.store, ...(opts.meshCore ? { meshCore: opts.meshCore } : {}) },
    opts.sources
  );
  const probe: CapabilityDefinition = {
    ...real,
    escalate: (_deps, call) => escalators.update(call),
    invoke: async (_deps, input) => {
      opts.reached.push(input);
      return { ok: true };
    },
  };
  const registry = composeRegistry([{ name: 'tasks', capabilities: [probe] }], {
    logger: noopLogger,
  });
  return (caller, args) => invokeCapabilityAsMcpResult(registry, probe.id, args, caller);
}
