import { useCurrentAgent, useCreateAgent, useAgentVisual } from '@/layers/entities/agent';
import { PathBreadcrumb, Skeleton } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';
import { Settings, FolderOpen } from 'lucide-react';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { shortenHomePath } from '@/layers/shared/lib';

interface AgentHeaderProps {
  /** Current working directory */
  cwd: string;
  /** Callback to open the directory picker */
  onOpenPicker: () => void;
  /** Callback to open the Agent Settings Dialog */
  onOpenAgentDialog: () => void;
}

/**
 * Sidebar header showing agent identity or directory path.
 *
 * When an agent is registered: prominent card with colored dot, emoji, bold name,
 * description, abbreviated path, a Switch button (opens command palette), and gear icon.
 * When no agent: folder icon + path breadcrumb + '+Agent' CTA + Switch button.
 *
 * Mobile behavior: tapping the identity area opens the command palette.
 * Desktop behavior: tapping the identity area opens the agent dialog.
 */
export function AgentHeader({ cwd, onOpenPicker, onOpenAgentDialog }: AgentHeaderProps) {
  const { data: agent, isLoading } = useCurrentAgent(cwd);
  const createAgent = useCreateAgent();
  const visual = useAgentVisual(agent ?? null, cwd);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const isMobile = useIsMobile();

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
    return <Skeleton className="mx-2 h-16 w-full" />;
  }

  if (agent) {
    return (
      <div className="flex flex-col gap-1 px-2 py-2">
        {/* Agent identity — tappable: opens palette on mobile, agent dialog on desktop */}
        <button
          onClick={isMobile ? handleOpenPalette : onOpenAgentDialog}
          className="hover:bg-accent flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150"
          aria-label={
            isMobile ? `Switch agent (current: ${agent.name})` : `Agent settings for ${agent.name}`
          }
        >
          <span
            className="mt-1 size-3 flex-shrink-0 rounded-full"
            style={{ backgroundColor: visual.color }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="text-sm">{visual.emoji}</span>
              <span className="truncate font-semibold">{agent.name}</span>
            </div>
            {agent.description && (
              <p className="text-muted-foreground truncate text-xs">{agent.description}</p>
            )}
            <p className="text-muted-foreground truncate text-xs">{shortenHomePath(cwd)}</p>
          </div>
        </button>

        {/* Action row: Switch button + gear icon */}
        <div className="flex items-center justify-between px-2">
          <button
            onClick={handleOpenPalette}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors duration-150"
            aria-label="Switch agent"
          >
            <Kbd>K</Kbd>
            <span>Switch</span>
          </button>
          <button
            onClick={onOpenAgentDialog}
            className="hover:bg-accent text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors duration-150"
            aria-label="Agent settings"
          >
            <Settings className="size-(--size-icon-sm)" />
          </button>
        </div>
      </div>
    );
  }

  // Unregistered directory: directory-based UX with Switch button
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      <div className="flex min-w-0 items-center gap-1">
        <button
          onClick={onOpenPicker}
          className="hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150"
          title={cwd}
          aria-label="Change working directory"
        >
          <FolderOpen className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
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
