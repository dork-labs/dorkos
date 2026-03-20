import { useState, useCallback } from 'react';
import { FolderOpen, User, Sparkles, Zap, Plug2 } from 'lucide-react';
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
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { IdentityTab } from './IdentityTab';
import { PersonaTab } from './PersonaTab';
import { CapabilitiesTab } from './CapabilitiesTab';
import { ConnectionsTab } from './ConnectionsTab';

interface AgentDialogProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog shell for agent configuration with sidebar navigation.
 * Four sections: Identity, Persona, Capabilities, and Connections.
 */
export function AgentDialog({ projectPath, open, onOpenChange }: AgentDialogProps) {
  const [activeTab, setActiveTab] = useState('identity');
  const { data: agent } = useCurrentAgent(projectPath);
  const updateAgent = useUpdateAgent();

  const handleUpdate = useCallback(
    (updates: Partial<AgentManifest>) => {
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
        <NavigationLayout value={activeTab} onValueChange={setActiveTab}>
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
              <NavigationLayoutItem value="persona" icon={Sparkles}>
                Persona
              </NavigationLayoutItem>
              <NavigationLayoutItem value="capabilities" icon={Zap}>
                Capabilities
              </NavigationLayoutItem>
              <NavigationLayoutItem value="connections" icon={Plug2}>
                Connections
              </NavigationLayoutItem>
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className="min-h-[280px] p-4">
              <NavigationLayoutPanel value="identity">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Identity</NavigationLayoutPanelHeader>
                  <IdentityTab agent={agent} projectPath={projectPath} onUpdate={handleUpdate} />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="persona">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Persona</NavigationLayoutPanelHeader>
                  <PersonaTab agent={agent} onUpdate={handleUpdate} />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="capabilities">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Capabilities</NavigationLayoutPanelHeader>
                  <CapabilitiesTab agent={agent} onUpdate={handleUpdate} />
                </div>
              </NavigationLayoutPanel>

              <NavigationLayoutPanel value="connections">
                <div className="space-y-4">
                  <NavigationLayoutPanelHeader>Connections</NavigationLayoutPanelHeader>
                  <ConnectionsTab agent={agent} />
                </div>
              </NavigationLayoutPanel>
            </NavigationLayoutContent>
          </NavigationLayoutBody>
        </NavigationLayout>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
