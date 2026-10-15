/** Response-only execution placement, never persisted into harness manifests. */
import { runtimeRegistry } from '../services/core/runtime-registry.js';
/** Attach placement only when the canonical path has a retained server binding. */
export function projectComputerPlacement<T extends { projectPath?: string }>(
  agent: T
): T & { effectiveRuntimeId?: string } {
  const effectiveRuntimeId = agent.projectPath
    ? runtimeRegistry.computerRuntimeForAgentPath(agent.projectPath)
    : undefined;
  return effectiveRuntimeId ? { ...agent, effectiveRuntimeId } : agent;
}

/** Project a path-free response using the Mesh registry's trusted id/path pair. */
export function projectComputerPlacementById<T extends { id: string }>(
  agent: T,
  paths: readonly { id: string; projectPath: string }[]
): T & { effectiveRuntimeId?: string } {
  const path = paths.find((row) => row.id === agent.id)?.projectPath;
  const effectiveRuntimeId = path ? runtimeRegistry.computerRuntimeForAgentPath(path) : undefined;
  return effectiveRuntimeId ? { ...agent, effectiveRuntimeId } : agent;
}
