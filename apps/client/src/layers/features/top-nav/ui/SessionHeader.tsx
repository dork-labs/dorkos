import { AgentIdentityChip } from './AgentIdentityChip';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentVisual } from '@/layers/entities/agent';

interface SessionHeaderProps {
  /** Current agent manifest, null when no agent is registered */
  agent: AgentManifest | null | undefined;
  /** Derived visual identity (color + emoji) */
  visual: AgentVisual;
  /** Whether the agent is currently streaming a response */
  isStreaming: boolean;
}

/** Session route header — agent identity chip + command palette trigger. */
export function SessionHeader({ agent, visual, isStreaming }: SessionHeaderProps) {
  return (
    <>
      <AgentIdentityChip agent={agent} visual={visual} isStreaming={isStreaming} />
      <div className="flex-1" />
      <CommandPaletteTrigger />
    </>
  );
}
