import { useCallback } from 'react';
import { FolderOpen, User, Sparkles, Wrench, Radio } from 'lucide-react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { TabbedDialog, type TabbedDialogTab, PathBreadcrumb } from '@/layers/shared/ui';
import type { AgentDialogTab } from '@/layers/shared/model';
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

/** Tabbed Agent configuration dialog (consumer of TabbedDialog primitive). */
export function AgentDialog({ projectPath, open, onOpenChange, initialTab }: AgentDialogProps) {
  const { data: agent } = useCurrentAgent(projectPath);
  const updateAgent = useUpdateAgent();

  const handleUpdate = useCallback(
    (updates: Partial<AgentManifest>) => updateAgent.mutate({ path: projectPath, updates }),
    [projectPath, updateAgent]
  );

  const handlePersonalityUpdate = useCallback(
    (updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }) =>
      updateAgent.mutate({ path: projectPath, updates }),
    [projectPath, updateAgent]
  );

  if (!agent) {
    return <NoAgentFallback projectPath={projectPath} open={open} onOpenChange={onOpenChange} />;
  }

  return (
    <AgentDialogProvider
      value={{
        agent,
        projectPath,
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
            <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
          </div>
        }
        defaultTab="identity"
        initialTab={initialTab ?? null}
        tabs={AGENT_TABS}
        testId="agent-dialog"
      />
    </AgentDialogProvider>
  );
}
