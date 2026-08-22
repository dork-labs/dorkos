import { Plus } from 'lucide-react';
import { BarTabStrip, Button, type BarTab } from '@/layers/shared/ui';
import { useAgentCreationStore, useIsMobile } from '@/layers/shared/model';
import type { TeamViewMode } from '@/layers/shared/lib';
import { useOneBarState } from '../model/one-bar-context';
import { BarTitle, OneBar } from './OneBar';

interface TeamView {
  mode: TeamViewMode;
  label: string;
  /** Starts the management group — see {@link TEAM_VIEW_TABS}. */
  startsGroup?: boolean;
}

/**
 * The five ways to look at the team, in strip order: three that draw the
 * roster, then two that are about the rules rather than about who is here.
 */
const TEAM_VIEWS: TeamView[] = [
  { mode: 'cards', label: 'Cards' },
  { mode: 'table', label: 'Table' },
  { mode: 'topology', label: 'Topology' },
  { mode: 'denied', label: 'Denied', startsGroup: true },
  { mode: 'access', label: 'Access' },
];

/**
 * The team views as bar tabs — links to `/team?view=<mode>`, with a rule drawn
 * before the first management view.
 *
 * **Every view is here at every width.** The switcher used to be a `<Select>`
 * below `md` that withheld the table (six columns at 375px is a scroll bar
 * wearing a table) and then had to smuggle it back in whenever you were
 * already on it, because a Select whose value matches no item renders blank.
 * The strip scrolls sideways instead, so the list is one list: nothing is
 * hidden, nothing has to be conditionally un-hidden, and the phone reaches the
 * last view the same way the desktop does.
 *
 * Exported so the dev playground shows the tabs the app ships rather than a
 * copy that can drift from them.
 */
export const TEAM_VIEW_TABS: BarTab[] = TEAM_VIEWS.map(({ mode, label, startsGroup }) => ({
  id: mode,
  label,
  to: '/team',
  // An updater, not a literal: the owner filter and the sort are the same
  // people asked about a different way, so they survive a change of view.
  search: (prev: Record<string, unknown>) => ({ ...prev, view: mode }),
  dividerBefore: startsGroup,
}));

/**
 * `/team` route bar — the title, the view strip, and the way to add an agent.
 */
export function TeamHeader() {
  const { teamViewMode: viewMode } = useOneBarState();
  const openCreateDialog = useAgentCreationStore((s) => s.open);
  const isMobile = useIsMobile();

  return (
    <OneBar
      identity={<BarTitle>Team</BarTitle>}
      fill={
        <BarTabStrip
          tabs={TEAM_VIEW_TABS}
          activeTabId={viewMode}
          label="Team views"
          indicatorLayoutId="team-view-tabs"
          testId="team-views"
        />
      }
      actions={
        <Button
          variant="outline"
          size="xs"
          onClick={() => openCreateDialog()}
          // On a phone the words are the first thing worth spending: five view
          // tabs and a title already want more than 390px, and `+` beside a
          // roster is not ambiguous. The label stays on the button either way,
          // so it is named the same for a screen reader at both widths.
          aria-label={isMobile ? 'New Agent' : undefined}
        >
          <Plus />
          {!isMobile && 'New Agent'}
        </Button>
      }
    />
  );
}
