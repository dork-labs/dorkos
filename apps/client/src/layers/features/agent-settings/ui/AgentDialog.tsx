import { useCallback, useState } from 'react';
import { FolderOpen, User, Sparkles, Wrench, Radio } from 'lucide-react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
  PathBreadcrumb,
  NavigationLayout,
  NavigationLayoutDialogHeader,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';
import type { AgentDialogTab } from '@/layers/shared/model';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { IdentityTab } from './IdentityTab';
import { PersonalityTab } from './PersonalityTab';
import { ToolsTab } from './ToolsTab';
import { ChannelsTab } from './ChannelsTab';

/** Server GET response augments manifest with convention file content. */
type AgentWithConventions = AgentManifest & {
  soulContent?: string | null;
  nopeContent?: string | null;
};

interface AgentDialogProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-navigate to a specific tab when the dialog opens. Defaults to 'identity'. */
  initialTab?: AgentDialogTab;
}

/**
 * Dialog shell for agent configuration with sidebar navigation.
 * Four sections: Identity, Personality, Tools, and Channels.
 */
export function AgentDialog({ projectPath, open, onOpenChange, initialTab }: AgentDialogProps) {
  const [activeTab, setActiveTab] = useState<AgentDialogTab>(initialTab ?? 'identity');
  const { data: agent } = useCurrentAgent(projectPath);
  const updateAgent = useUpdateAgent();

  // Reset active tab when dialog opens with a pre-targeted tab (React-recommended
  // "adjust state during render" pattern — avoids setState-in-effect lint warning)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open && !prevOpen && initialTab) {
    setActiveTab(initialTab);
  }
  if (open !== prevOpen) {
    setPrevOpen(open);
  }

  const handleUpdate = useCallback(
    (updates: Partial<AgentManifest>) => {
      updateAgent.mutate({ path: projectPath, updates });
    },
    [projectPath, updateAgent]
  );

  const handlePersonalityUpdate = useCallback(
    (updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }) => {
      updateAgent.mutate({ path: projectPath, updates });
    },
    [projectPath, updateAgent]
  );

  if (!agent) {
    return (
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent className="max-h-[85vh] max-w-lg gap-0 p-0">
          <ResponsiveDialogHeader className="space-y-0 border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">Agent</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Agent configuration
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="flex h-32 flex-col items-center justify-center gap-2">
            <p className="text-muted-foreground text-sm">No agent registered</p>
            <div className="text-muted-foreground/60 flex items-center gap-1.5">
              <FolderOpen className="size-3.5 flex-shrink-0" />
              <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
            </div>
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="agent-dialog"
        className="max-h-[85vh] max-w-2xl gap-0 p-0"
      >
        <NavigationLayout
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as AgentDialogTab)}
        >
          <ResponsiveDialogFullscreenToggle />
          <NavigationLayoutDialogHeader>
            <ResponsiveDialogTitle className="text-sm font-medium">
              {agent.name}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Agent configuration
            </ResponsiveDialogDescription>
            <div className="text-muted-foreground/60 flex items-center gap-1.5 pt-1">
              <FolderOpen className="size-3 flex-shrink-0" />
              <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
            </div>
          </NavigationLayoutDialogHeader>

          <NavigationLayoutBody>
            <NavigationLayoutSidebar>
              <NavigationLayoutItem value="identity" icon={User}>
                Identity
              </NavigationLayoutItem>
              <NavigationLayoutItem value="personality" icon={Sparkles}>
                Personality
              </NavigationLayoutItem>
              <NavigationLayoutItem value="tools" icon={Wrench}>
                Tools
              </NavigationLayoutItem>
              <NavigationLayoutItem value="channels" icon={Radio}>
                Channels
              </NavigationLayoutItem>
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className="min-h-[280px] p-4">
              <NavigationLayoutPanel value="identity">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Identity</NavigationLayoutPanelHeader>
                  <IdentityTab agent={agent} onUpdate={handleUpdate} />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="personality">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Personality</NavigationLayoutPanelHeader>
                  <PersonalityTab
                    agent={agent}
                    soulContent={(agent as AgentWithConventions).soulContent ?? null}
                    nopeContent={(agent as AgentWithConventions).nopeContent ?? null}
                    onUpdate={handlePersonalityUpdate}
                  />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="tools">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Tools</NavigationLayoutPanelHeader>
                  <ToolsTab agent={agent} projectPath={projectPath} onUpdate={handleUpdate} />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="channels">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Channels</NavigationLayoutPanelHeader>
                  <ChannelsTab agent={agent} />
                </div>
              </NavigationLayoutPanel>
            </NavigationLayoutContent>
          </NavigationLayoutBody>
        </NavigationLayout>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
