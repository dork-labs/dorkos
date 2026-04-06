import { createContext, useContext, type ReactNode } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/**
 * Shape of the shared state plumbed into all AgentDialog tab consumers via React Context.
 *
 * Holds the loaded agent, its project path, and the two mutation callbacks
 * so that parameterless `TabbedDialogTab.component` wrappers can forward
 * them to the inner tab components.
 */
export interface AgentDialogContextValue {
  agent: AgentManifest;
  projectPath: string;
  onUpdate: (updates: Partial<AgentManifest>) => void;
  onPersonalityUpdate: (
    updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }
  ) => void;
}

const AgentDialogContext = createContext<AgentDialogContextValue | undefined>(undefined);

/**
 * Provides shared agent state to all AgentDialog tab consumer wrappers.
 *
 * Wrap `<TabbedDialog>` in this provider so that `IdentityTabConsumer`,
 * `PersonalityTabConsumer`, `ToolsTabConsumer`, and `ChannelsTabConsumer`
 * can read `agent`, `projectPath`, and the mutation callbacks without
 * receiving explicit props.
 *
 * @param value - The context value containing the agent and callbacks.
 * @param children - React subtree (must include a `TabbedDialog`).
 */
export function AgentDialogProvider({
  value,
  children,
}: {
  value: AgentDialogContextValue;
  children: ReactNode;
}) {
  return <AgentDialogContext.Provider value={value}>{children}</AgentDialogContext.Provider>;
}

/**
 * Reads shared agent state from the nearest `AgentDialogProvider`.
 *
 * Throws if called outside a provider — this is a load-bearing safety
 * guard that surfaces misconfigured consumer wrappers at development time
 * rather than allowing silent undefined-state bugs in production.
 *
 * @returns The current `AgentDialogContextValue`.
 * @throws {Error} When called outside an `AgentDialogProvider`.
 */
export function useAgentDialog(): AgentDialogContextValue {
  const ctx = useContext(AgentDialogContext);
  if (!ctx) throw new Error('useAgentDialog must be used within an AgentDialogProvider');
  return ctx;
}
