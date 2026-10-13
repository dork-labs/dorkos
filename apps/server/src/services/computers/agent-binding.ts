/** Server-owned placement identity is separate from the agent's OpenCode harness manifest. */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';

/** One durable computer record hydrates this exact agent/path binding at startup. */
export class ComputerAgentBinding {
  private binding?: { id: string; path: string };
  constructor(
    private readonly runtimes?: ReadonlyMap<string, AgentRuntime>,
    private readonly defaultRuntime?: () => AgentRuntime
  ) {}
  resolve(
    id: string,
    mesh?: { getAgent(id: string): { runtime?: string } | undefined }
  ): AgentRuntime {
    if (!this.runtimes || !this.defaultRuntime) throw new Error('COMPUTER_REGISTRY_UNAVAILABLE');
    return resolveRegisteredAgentRuntime(id, mesh, this.runtimes, this.defaultRuntime, this);
  }
  configure(id: string, path: string): void {
    if (!id || id.length > 128 || !path.startsWith('/') || canonicalDirectory(path) !== path) {
      throw new Error('COMPUTER_AGENT_BINDING_REFUSED');
    }
    if (this.binding && (this.binding.id !== id || this.binding.path !== path)) {
      throw new Error('COMPUTER_AGENT_BINDING_REFUSED');
    }
    this.binding = { id, path };
  }
  forPath(path: string): 'computer-local' | undefined {
    return this.binding?.path === path ? 'computer-local' : undefined;
  }
  forId(id: string): 'computer-local' | undefined {
    return this.binding?.id === id ? 'computer-local' : undefined;
  }
}

/** Preserve the host preference ladder; a computer binding is instead a strict placement. */
export function resolveRegisteredAgentRuntime(
  id: string,
  mesh: { getAgent(id: string): { runtime?: string } | undefined } | undefined,
  runtimes: ReadonlyMap<string, AgentRuntime>,
  defaultRuntime: () => AgentRuntime,
  binding: ComputerAgentBinding
): AgentRuntime {
  const placed = binding.forId(id);
  if (placed) {
    const runtime = runtimes.get(placed);
    if (!runtime) throw new Error('COMPUTER_RUNTIME_UNAVAILABLE');
    return runtime;
  }
  const requested = mesh?.getAgent(id)?.runtime;
  return (requested && runtimes.get(requested)) || defaultRuntime();
}

/** Refuse unknown execution runtimes without changing placement. */
export function requireRegisteredRuntime(
  runtimes: ReadonlyMap<string, AgentRuntime>,
  type: string,
  options: { asDefault?: boolean } = {}
): AgentRuntime {
  // Retained computer placements never own ordinary host chats.
  if (options.asDefault && type === 'computer-local')
    throw new Error('Computer runtime is placement-only');
  const runtime = runtimes.get(type);
  if (!runtime) throw new Error(`Runtime '${type}' not registered`);
  return runtime;
}
