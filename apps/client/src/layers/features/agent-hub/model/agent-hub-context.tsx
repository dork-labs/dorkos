import { createContext, useContext, type ReactNode } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

export interface AgentHubContextValue {
  agent: AgentManifest;
  projectPath: string;
  onUpdate: (updates: Partial<AgentManifest>) => void;
  onPersonalityUpdate: (
    updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }
  ) => void;
  /** Temporary color override shown on hover — does not persist. */
  previewColor: string | null;
  /** Set/clear the temporary preview color (null to clear). */
  onPreviewColor: (color: string | null) => void;
  /** Whether the avatar picker panel is currently open. */
  isPickerOpen: boolean;
}

const AgentHubContext = createContext<AgentHubContextValue | undefined>(undefined);

/**
 * Provides AgentHubContext to descendant components.
 *
 * @param value - The context value containing the active agent and callbacks.
 * @param children - Child nodes that can consume the context.
 */
export function AgentHubProvider({
  value,
  children,
}: {
  value: AgentHubContextValue;
  children: ReactNode;
}) {
  return <AgentHubContext.Provider value={value}>{children}</AgentHubContext.Provider>;
}

/**
 * Returns the nearest AgentHubContext value.
 * Throws when called outside an AgentHubProvider.
 */
export function useAgentHubContext(): AgentHubContextValue {
  const ctx = useContext(AgentHubContext);
  if (!ctx) throw new Error('useAgentHubContext must be used within an AgentHubProvider');
  return ctx;
}
