import { useCurrentAgent, useCreateAgent } from '@/layers/entities/agent';
import { PathBreadcrumb, Skeleton } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';
import { FolderOpen } from 'lucide-react';
import { useAppStore } from '@/layers/shared/model';

interface AgentHeaderProps {
  /** Current working directory */
  cwd: string;
  /** Callback to open the directory picker */
  onOpenPicker: () => void;
  /** Callback to open the Agent Settings Dialog */
  onOpenAgentDialog: () => void;
}

/**
 * Sidebar header showing directory context and quick actions.
 *
 * Agent identity (name, color dot) now lives in the top navigation bar.
 * This component provides directory path display, agent switching via command palette,
 * and a quick-create CTA for unregistered directories.
 */
export function AgentHeader({ cwd, onOpenPicker, onOpenAgentDialog }: AgentHeaderProps) {
  const { data: agent, isLoading } = useCurrentAgent(cwd);
  const createAgent = useCreateAgent();
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);

  const handleQuickCreate = async () => {
    try {
      await createAgent.mutateAsync({ path: cwd });
      onOpenAgentDialog();
    } catch {
      // Toast error handled by mutation
    }
  };

  const handleOpenPalette = () => setGlobalPaletteOpen(true);

  if (isLoading) {
    return <Skeleton className="mx-2 h-10 w-full" />;
  }

  if (agent) {
    // Agent registered: show path + K Switch
    return (
      <div className="flex flex-col gap-1 px-2 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <button
            onClick={onOpenPicker}
            className="hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150"
            title={cwd}
            aria-label="Change working directory"
          >
            <FolderOpen className="text-muted-foreground size-(--size-icon-sm) shrink-0" />
            <PathBreadcrumb path={cwd} maxSegments={3} size="sm" />
          </button>
        </div>
        <div className="px-1">
          <button
            onClick={handleOpenPalette}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors duration-150"
            aria-label="Switch agent"
          >
            <Kbd>K</Kbd>
            <span>Switch</span>
          </button>
        </div>
      </div>
    );
  }

  // Unregistered directory: path + "+Agent" CTA + K Switch
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      <div className="flex min-w-0 items-center gap-1">
        <button
          onClick={onOpenPicker}
          className="hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150"
          title={cwd}
          aria-label="Change working directory"
        >
          <FolderOpen className="text-muted-foreground size-(--size-icon-sm) shrink-0" />
          <PathBreadcrumb path={cwd} maxSegments={3} size="sm" />
        </button>
        <button
          onClick={handleQuickCreate}
          disabled={createAgent.isPending}
          className="text-muted-foreground hover:text-foreground whitespace-nowrap text-xs transition-colors duration-150 disabled:opacity-50"
          aria-label="Create agent for this directory"
        >
          + Agent
        </button>
      </div>
      <div className="px-1">
        <button
          onClick={handleOpenPalette}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors duration-150"
          aria-label="Open command palette"
        >
          <Kbd>K</Kbd>
          <span>Switch</span>
        </button>
      </div>
    </div>
  );
}
