import { useCallback } from 'react';
import { FolderOpen, User, Sparkles, Wrench, Radio } from 'lucide-react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { TabbedDialog, type TabbedDialogTab, PathBreadcrumb } from '@/layers/shared/ui';
import { useAgentDialogDeepLink, type AgentDialogTab } from '@/layers/shared/model';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { AgentDialogProvider } from '../model/agent-dialog-context';
import { IdentityTabConsumer } from './consumers/IdentityTabConsumer';
import { PersonalityTabConsumer } from './consumers/PersonalityTabConsumer';
import { ToolsTabConsumer } from './consumers/ToolsTabConsumer';
import { ChannelsTabConsumer } from './consumers/ChannelsTabConsumer';
import { NoAgentFallback } from './NoAgentFallback';

const AGENT_TABS: TabbedDialogTab<AgentDialogTab>[] = [
  { id: 'identity', label: 'Identity', icon: User, component: IdentityTabConsumer },
  { id: 'personality', label: 'Personality', icon: Sparkles, component: PersonalityTabConsumer },
  { id: 'tools', label: 'Tools', icon: Wrench, component: ToolsTabConsumer },
  { id: 'channels', label: 'Channels', icon: Radio, component: ChannelsTabConsumer },
];

interface AgentDialogProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: AgentDialogTab;
}

/**
 * Tabbed Agent configuration dialog (consumer of TabbedDialog primitive).
 *
 * Reads the active tab and agent path from the URL via `useAgentDialogDeepLink`,
 * with URL values taking precedence over the store-driven `initialTab` prop and
 * wrapper-provided `projectPath`. This enables deep links like
 * `?agent=identity&agentPath=/abs/path` while still supporting store-based opens
 * from the command palette and other legacy callsites.
 */
export function AgentDialog({ projectPath, open, onOpenChange, initialTab }: AgentDialogProps) {
  const { activeTab: urlTab, agentPath: urlAgentPath } = useAgentDialogDeepLink();

  // URL `agentPath` takes precedence over the wrapper-provided prop so that
  // `?agent=identity&agentPath=/foo` opens the dialog for `/foo` even when the
  // current directory selection points elsewhere.
  const effectivePath = urlAgentPath ?? projectPath;

  // URL `agent` tab takes precedence over the store-driven `initialTab` prop.
  // `TabbedDialog` internally re-syncs `initialTab` on each open transition via
  // `useDialogTabState`, so both the store-based and URL-based flows land on
  // the right tab on open.
  const effectiveInitialTab = urlTab ?? initialTab ?? null;

  const { data: agent } = useCurrentAgent(effectivePath);
  const updateAgent = useUpdateAgent();

  const handleUpdate = useCallback(
    (updates: Partial<AgentManifest>) => updateAgent.mutate({ path: effectivePath, updates }),
    [effectivePath, updateAgent]
  );

  const handlePersonalityUpdate = useCallback(
    (updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }) =>
      updateAgent.mutate({ path: effectivePath, updates }),
    [effectivePath, updateAgent]
  );

  if (!agent) {
    return <NoAgentFallback projectPath={effectivePath} open={open} onOpenChange={onOpenChange} />;
  }

  return (
    <AgentDialogProvider
      value={{
        agent,
        projectPath: effectivePath,
        onUpdate: handleUpdate,
        onPersonalityUpdate: handlePersonalityUpdate,
      }}
    >
      <TabbedDialog
        open={open}
        onOpenChange={onOpenChange}
        title={agent.name}
        description="Agent configuration"
        headerSlot={
          <div className="text-muted-foreground/60 flex items-center gap-1.5 pt-1">
            <FolderOpen className="size-3 flex-shrink-0" />
            <PathBreadcrumb path={effectivePath} maxSegments={3} size="sm" />
          </div>
        }
        defaultTab="identity"
        initialTab={effectiveInitialTab}
        tabs={AGENT_TABS}
        testId="agent-dialog"
      />
    </AgentDialogProvider>
  );
}
