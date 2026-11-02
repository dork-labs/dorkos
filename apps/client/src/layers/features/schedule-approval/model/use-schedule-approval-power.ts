import type { Task } from '@dorkos/shared/types';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCapabilitiesForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useConfig } from '@/layers/entities/config';
import { operatorStopForRuntime, resolveConfiguredStopMode } from '@/layers/shared/lib';

/** Resolve every mode through the same task → registered agent → default ladder as a run. */
export function useScheduleApprovalPower(task: Task) {
  const { data: map } = useRuntimeCapabilities();
  const { data: config } = useConfig();
  const {
    data: agents,
    isPending: agentsPending,
    isError: agentsError,
  } = useRegisteredAgents(undefined, task.agentId !== null);
  const agentRuntime = task.agentId
    ? agents?.agents.find((agent) => agent.id === task.agentId)?.runtime
    : null;
  const registeredAgentRuntime =
    agentRuntime && map && Object.hasOwn(map.capabilities, agentRuntime) ? agentRuntime : null;
  const runtime = task.runtime ?? registeredAgentRuntime ?? map?.defaultRuntime ?? null;
  const capabilities = useCapabilitiesForRuntime(runtime);
  // Do not offer the default runtime's modes while the owning agent is still
  // unknown: the mode id can mean something different on that agent's runtime.
  const agentUnknown =
    task.runtime === null && task.agentId !== null && (agentsPending || agentsError);
  const modes = agentUnknown ? [] : (capabilities?.permissionModes?.values ?? []);
  const stop = runtime ? operatorStopForRuntime(config?.executionDefaults, runtime) : null;
  const ceiling = modes.find((mode) => mode.id === resolveConfiguredStopMode(stop, modes));
  return { modes, ceiling, current: modes.find((mode) => mode.id === task.permissionMode) ?? null };
}
