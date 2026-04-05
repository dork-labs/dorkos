import { useState, useCallback, useEffect } from 'react';
import { FolderOpen, User, Sparkles, Zap, Radio } from 'lucide-react';
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
import type { AgentManifest, Traits, Conventions } from '@dorkos/shared/mesh-schemas';
import { IdentityTab } from './IdentityTab';
import { PersonalityTab } from './PersonalityTab';
import { CapabilitiesTab } from './CapabilitiesTab';
import { ChannelsTab } from './ChannelsTab';

interface AgentDialogProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-navigate to a specific tab when the dialog opens. Defaults to 'identity'. */
  initialTab?: AgentDialogTab;
}

/**
 * Dialog shell for agent configuration with sidebar navigation.
 * Four sections: Identity, Personality, Capabilities, and Channels.
 */
export function AgentDialog({ projectPath, open, onOpenChange, initialTab }: AgentDialogProps) {
  const [activeTab, setActiveTab] = useState<AgentDialogTab>(initialTab ?? 'identity');
  const { data: agent } = useCurrentAgent(projectPath);
  const updateAgent = useUpdateAgent();

  // Sync active tab when dialog opens with a pre-targeted tab
  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  const handleUpdate = useCallback(
    (updates: Partial<AgentManifest>) => {
      updateAgent.mutate({ path: projectPath, updates });
    },
    [projectPath, updateAgent]
  );

  const handlePersonalityUpdate = useCallback(
    (updates: {
      traits?: Traits;
      conventions?: Conventions;
      soulContent?: string;
      nopeContent?: string;
    }) => {
      // Pass manifest-level fields through; soulContent/nopeContent are handled
      // by the server's convention file PATCH (task 2.2).
      updateAgent.mutate({
        path: projectPath,
        updates: updates as Partial<AgentManifest>,
      });
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
              <NavigationLayoutItem value="capabilities" icon={Zap}>
                Capabilities
              </NavigationLayoutItem>
              <NavigationLayoutItem value="channels" icon={Radio}>
                Channels
              </NavigationLayoutItem>
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className="min-h-[280px] p-4">
              <NavigationLayoutPanel value="identity">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Identity</NavigationLayoutPanelHeader>
                  <IdentityTab agent={agent} projectPath={projectPath} onUpdate={handleUpdate} />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="personality">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Personality</NavigationLayoutPanelHeader>
                  <PersonalityTab
                    agent={agent}
                    soulContent={
                      (agent as AgentManifest & { soulContent?: string | null }).soulContent ?? null
                    }
                    nopeContent={
                      (agent as AgentManifest & { nopeContent?: string | null }).nopeContent ?? null
                    }
                    onUpdate={handlePersonalityUpdate}
                  />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="capabilities">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Capabilities</NavigationLayoutPanelHeader>
                  <CapabilitiesTab agent={agent} onUpdate={handleUpdate} />
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
