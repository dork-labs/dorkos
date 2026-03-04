import { useState, useCallback } from 'react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
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
 * Dialog shell for agent configuration with tabbed navigation.
 * Four tabs: Identity, Persona, Capabilities, and Connections.
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
            <ResponsiveDialogTitle className="text-sm font-medium">
              Agent
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Agent configuration
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground text-sm">No agent registered</p>
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="agent-dialog"
        className="max-h-[85vh] max-w-lg gap-0 p-0"
      >
        <ResponsiveDialogFullscreenToggle />
        <ResponsiveDialogHeader className="space-y-0 border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">
            {agent.name}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-muted-foreground text-xs">
            Agent configuration
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <TabsList
            className="mx-4 mt-3 grid w-full grid-cols-4"
            style={{ width: 'calc(100% - 2rem)' }}
          >
            <TabsTrigger value="identity">Identity</TabsTrigger>
            <TabsTrigger value="persona">Persona</TabsTrigger>
            <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
            <TabsTrigger value="connections">Connections</TabsTrigger>
          </TabsList>

          <div className="min-h-[280px] flex-1 overflow-y-auto p-4">
            <TabsContent value="identity" className="mt-0">
              <IdentityTab
                agent={agent}
                projectPath={projectPath}
                onUpdate={handleUpdate}
              />
            </TabsContent>

            <TabsContent value="persona" className="mt-0">
              <PersonaTab agent={agent} onUpdate={handleUpdate} />
            </TabsContent>

            <TabsContent value="capabilities" className="mt-0">
              <CapabilitiesTab agent={agent} onUpdate={handleUpdate} />
            </TabsContent>

            <TabsContent value="connections" className="mt-0">
              <ConnectionsTab agent={agent} />
            </TabsContent>
          </div>
        </Tabs>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
