import { useState } from 'react';
import { Plus, ScanSearch } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui/responsive-dialog';
import { DiscoveryView } from '@/layers/features/mesh';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { PageHeader } from './PageHeader';

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
      <PageHeader
        title="Agents"
        actions={
          <>
            <Button variant="outline" size="xs" onClick={openCreateDialog}>
              <Plus />
              New Agent
            </Button>
            <Button variant="outline" size="xs" onClick={() => setDiscoveryOpen(true)}>
              <ScanSearch />
              Scan for Agents
            </Button>
          </>
        }
      >
        {!isMobile && (
          <div className="bg-muted flex items-center rounded-md p-0.5">
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
      </PageHeader>
      <ResponsiveDialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <ResponsiveDialogContent className="max-h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogHeader className="px-6 pt-6 pb-4">
            <ResponsiveDialogTitle>Discover Agents</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Scan directories to find agents on your computer
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="px-6 pb-6">
            <DiscoveryView />
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
