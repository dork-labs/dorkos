import { Plus, List, Globe, ShieldBan, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/layers/shared/ui';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { PageHeader } from './PageHeader';

type ViewMode = 'list' | 'topology' | 'denied' | 'access';

const PRIMARY_TABS: { mode: ViewMode; label: string; icon: LucideIcon }[] = [
  { mode: 'list', label: 'Agents', icon: List },
  { mode: 'topology', label: 'Topology', icon: Globe },
];

const MANAGEMENT_TABS: { mode: ViewMode; label: string; icon: LucideIcon }[] = [
  { mode: 'denied', label: 'Denied', icon: ShieldBan },
  { mode: 'access', label: 'Access', icon: Lock },
];

interface AgentsHeaderProps {
  /** Current view mode — passed from the shell to avoid useSearch during exit animations. */
  viewMode: ViewMode;
}

/** Page header for the /agents route — title, view switcher, and new agent button. */
export function AgentsHeader({ viewMode }: AgentsHeaderProps) {
  const openCreateDialog = useAgentCreationStore((s) => s.open);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  function handleViewChange(mode: ViewMode) {
    void navigate({ to: '/agents', search: (prev) => ({ ...prev, view: mode }) });
  }

  return (
    <PageHeader
      title="Agents"
      actions={
        <Button variant="outline" size="xs" onClick={() => openCreateDialog()}>
          <Plus />
          New Agent
        </Button>
      }
    >
      {!isMobile && (
        <div className="bg-muted flex items-center rounded-md p-0.5">
          {/* Primary group */}
          {PRIMARY_TABS.map(({ mode, label }) => (
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
          {/* Separator */}
          <div className="mx-1 h-4 border-l" />
          {/* Management group */}
          {MANAGEMENT_TABS.map(({ mode, label }) => (
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
      {isMobile && (
        <Select value={viewMode} onValueChange={(v) => handleViewChange(v as ViewMode)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...PRIMARY_TABS, ...MANAGEMENT_TABS].map(({ mode, label }) => (
              <SelectItem key={mode} value={mode}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </PageHeader>
  );
}
