import { Plus } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/layers/shared/ui';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useIsMobile } from '@/layers/shared/model';
import { cn, type TeamViewMode } from '@/layers/shared/lib';
import { useOneBarState } from '../model/one-bar-context';
import { BarTitle, OneBar } from './OneBar';

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
 * What the switch offers on a phone.
 *
 * The table is not among them: six columns at 375px is not a view, it is a
 * horizontal scroll bar wearing one, and everything the table says is on the
 * cards, which are built for that width. So the option is absent rather than
 * present-and-bad.
 *
 * **Unless you are already on it.** `/agents?view=list` is a live external
 * address, so a phone can land on the table in one hop, and a Select whose
 * value matches no item renders BLANK — the switch would stop saying where you
 * are at exactly the moment you most need it to. So the current view is always
 * in the list, even when it is one this width does not otherwise offer.
 *
 * @param viewMode - The view showing right now.
 */
function mobileTabs(viewMode: TeamViewMode): ViewTab[] {
  const offered = [...PRIMARY_TABS, ...MANAGEMENT_TABS];
  return offered.filter((tab) => tab.mode !== 'table' || viewMode === 'table');
}

const TAB_CLASS = 'text-xs font-medium transition-colors';
const TAB_ACTIVE = 'bg-background text-foreground rounded-md px-3 py-1 shadow-sm';
const TAB_IDLE = 'text-muted-foreground hover:text-foreground px-3 py-1';

/**
 * `/team` route bar — title, view switcher, and new agent button.
 *
 * The pill row and the mobile `<Select>` are still here. Phase T1 replaces both
 * with a `BarTabStrip`, which is why they have not been touched by the
 * foundation change beyond the layout they sit in.
 */
export function TeamHeader() {
  const { teamViewMode: viewMode } = useOneBarState();
  const openCreateDialog = useAgentCreationStore((s) => s.open);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  function handleViewChange(mode: TeamViewMode) {
    void navigate({ to: '/team', search: (prev) => ({ ...prev, view: mode }) });
  }

  const viewSwitcher = (
    <>
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
            {mobileTabs(viewMode).map(({ mode, label }) => (
              <SelectItem key={mode} value={mode}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  );

  return (
    <OneBar
      identity={<BarTitle>Team</BarTitle>}
      fill={viewSwitcher}
      actions={
        <Button variant="outline" size="xs" onClick={() => openCreateDialog()}>
          <Plus />
          New Agent
        </Button>
      }
    />
  );
}
