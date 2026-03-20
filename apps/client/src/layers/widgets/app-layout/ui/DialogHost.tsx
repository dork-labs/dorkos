import { useMemo } from 'react';
import { useAppStore } from '@/layers/shared/model';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
  DirectoryPicker,
} from '@/layers/shared/ui';
import { useDirectoryState } from '@/layers/entities/session';
import { useResolvedAgents } from '@/layers/entities/agent';
import { SettingsDialog } from '@/layers/features/settings';
import { PulsePanel } from '@/layers/features/pulse';
import { RelayPanel } from '@/layers/features/relay';
import { MeshPanel } from '@/layers/features/mesh';
import { AgentDialog } from '@/layers/features/agent-settings';
import { OnboardingFlow } from '@/layers/features/onboarding';

/**
 * Root-level dialog host that renders all application dialogs outside
 * the SidebarProvider. This ensures dialogs survive sidebar open/close
 * cycles and mobile Sheet unmounts.
 */
export function DialogHost() {
  const {
    settingsOpen,
    setSettingsOpen,
    pulseOpen,
    setPulseOpen,
    relayOpen,
    setRelayOpen,
    meshOpen,
    setMeshOpen,
    pickerOpen,
    setPickerOpen,
    agentDialogOpen,
    setAgentDialogOpen,
    onboardingStep,
    setOnboardingStep,
    recentCwds,
  } = useAppStore();

  const [selectedCwd, setSelectedCwd] = useDirectoryState();
  const recentPaths = useMemo(() => recentCwds.map((r) => r.path), [recentCwds]);
  const { data: resolvedAgents } = useResolvedAgents(recentPaths);

  return (
    <>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(path) => setSelectedCwd(path)}
        initialPath={selectedCwd}
        resolvedAgents={resolvedAgents}
      />
      <ResponsiveDialog open={pulseOpen} onOpenChange={setPulseOpen}>
        <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogFullscreenToggle />
          <ResponsiveDialogHeader className="border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">
              Pulse Scheduler
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Manage scheduled AI agent tasks
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <PulsePanel />
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog open={relayOpen} onOpenChange={setRelayOpen}>
        <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogFullscreenToggle />
          <ResponsiveDialogHeader className="border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">
              Connections
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Manage adapters and monitor message activity
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <RelayPanel />
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog open={meshOpen} onOpenChange={setMeshOpen}>
        <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogFullscreenToggle />
          <ResponsiveDialogHeader className="border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">Mesh</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Agent discovery and registry
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <MeshPanel />
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      {selectedCwd && (
        <AgentDialog
          projectPath={selectedCwd}
          open={agentDialogOpen}
          onOpenChange={setAgentDialogOpen}
        />
      )}
      {onboardingStep !== null && (
        <div className="bg-background fixed inset-0 z-50">
          <OnboardingFlow initialStep={onboardingStep} onComplete={() => setOnboardingStep(null)} />
        </div>
      )}
    </>
  );
}
