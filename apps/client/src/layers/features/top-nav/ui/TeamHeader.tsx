import { Plus } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/layers/shared/ui';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useIsMobile } from '@/layers/shared/model';
import { cn, type TeamViewMode } from '@/layers/shared/lib';
import { PageHeader } from './PageHeader';

interface ViewTab {
  mode: TeamViewMode;
  label: string;
}

/** The two ways to read the roster, plus the map of the fleet. */
const PRIMARY_TABS: ViewTab[] = [
  { mode: 'cards', label: 'Cards' },
  { mode: 'table', label: 'Table' },
  { mode: 'topology', label: 'Topology' },
];

/** The mesh's management surfaces — about rules, not about who is here. */
const MANAGEMENT_TABS: ViewTab[] = [
  { mode: 'denied', label: 'Denied' },
  { mode: 'access', label: 'Access' },
];

/**
 * The table is not offered on a phone.
 *
 * Six columns at 375px is not a view, it is a horizontal scroll bar wearing
 * one — and everything the table says is on the cards, which are built for that
 * width. So the option is absent rather than present-and-bad.
 */
const MOBILE_TABS: ViewTab[] = [...PRIMARY_TABS, ...MANAGEMENT_TABS].filter(
  (tab) => tab.mode !== 'table'
);

const TAB_CLASS = 'text-xs font-medium transition-colors';
const TAB_ACTIVE = 'bg-background text-foreground rounded-md px-3 py-1 shadow-sm';
const TAB_IDLE = 'text-muted-foreground hover:text-foreground px-3 py-1';

interface TeamHeaderProps {
  /** Current view mode — passed from the shell to avoid useSearch during exit animations. */
  viewMode: TeamViewMode;
}

/** Page header for the `/team` route — title, view switcher, and new agent button. */
export function TeamHeader({ viewMode }: TeamHeaderProps) {
  const openCreateDialog = useAgentCreationStore((s) => s.open);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  function handleViewChange(mode: TeamViewMode) {
    void navigate({ to: '/team', search: (prev) => ({ ...prev, view: mode }) });
  }

  return (
    <PageHeader
      title="Team"
      actions={
        <Button variant="outline" size="xs" onClick={() => openCreateDialog()}>
          <Plus />
          New Agent
        </Button>
      }
    >
      {!isMobile && (
        <div className="bg-muted flex items-center rounded-md p-0.5">
          {PRIMARY_TABS.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleViewChange(mode)}
              className={cn(TAB_CLASS, viewMode === mode ? TAB_ACTIVE : TAB_IDLE)}
            >
              {label}
            </button>
          ))}
          <div className="mx-1 h-4 border-l" />
          {MANAGEMENT_TABS.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleViewChange(mode)}
              className={cn(TAB_CLASS, viewMode === mode ? TAB_ACTIVE : TAB_IDLE)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {isMobile && (
        <Select value={viewMode} onValueChange={(v) => handleViewChange(v as TeamViewMode)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MOBILE_TABS.map(({ mode, label }) => (
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
