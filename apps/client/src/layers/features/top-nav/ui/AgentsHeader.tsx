import { useState } from 'react';
import { Plus, ScanSearch } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui/responsive-dialog';
import { DiscoveryView } from '@/layers/features/mesh';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import type { AgentsSearch } from '@/router';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';

type ViewMode = 'list' | 'topology';

const VIEW_TABS: { mode: ViewMode; label: string }[] = [
  { mode: 'list', label: 'Agents' },
  { mode: 'topology', label: 'Topology' },
];

interface AgentsHeaderProps {
  /** Current view mode — passed from the shell to avoid useSearch during exit animations. */
  viewMode: ViewMode;
}

/** Page header for the /agents route — title, view switcher, scan trigger, and command palette. */
export function AgentsHeader({ viewMode }: AgentsHeaderProps) {
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const openCreateDialog = useAgentCreationStore((s) => s.open);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  function handleViewChange(mode: ViewMode) {
    void navigate({ to: '/agents', search: { view: mode } });
  }

  return (
    <>
      <span className="text-sm font-medium">Agents</span>
      {!isMobile && (
        <div className="bg-muted ml-4 flex items-center rounded-md p-0.5">
          {VIEW_TABS.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleViewChange(mode)}
              className={cn(
                'text-xs font-medium transition-colors',
                viewMode === mode
                  ? 'bg-background text-foreground rounded-md px-3 py-1 shadow-sm'
                  : 'text-muted-foreground hover:text-foreground px-3 py-1'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 min-h-[44px] gap-1.5 text-xs sm:min-h-0"
          onClick={openCreateDialog}
        >
          <Plus className="size-3.5" />
          New Agent
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 min-h-[44px] gap-1.5 text-xs sm:min-h-0"
          onClick={() => setDiscoveryOpen(true)}
        >
          <ScanSearch className="size-3.5" />
          Scan for Agents
        </Button>
        <CommandPaletteTrigger />
      </div>
      <ResponsiveDialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <ResponsiveDialogContent className="max-w-2xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Discover Agents</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <DiscoveryView />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
