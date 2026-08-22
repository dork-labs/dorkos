import { Plus } from 'lucide-react';
import { BarTabStrip, Button, type BarTab } from '@/layers/shared/ui';
import { useAgentCreationStore, useIsMobile } from '@/layers/shared/model';
import { cn, type TeamViewMode } from '@/layers/shared/lib';
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

interface TeamHeaderProps {
  /**
   * Layout id for the sliding active marker, for the one caller that mounts
   * more than one of these bars at once.
   *
   * `motion` treats a `layoutId` as global: every element sharing one is the
   * SAME element to it, animating between wherever the copies are. The route
   * mounts a single bar, so the default is right for the app — but the dev
   * playground shows eight of them at once to demonstrate each active view,
   * and with one id between them the underlines collapsed onto whichever
   * instance mounted last, leaving seven bars with their marker parked under
   * another bar's tab.
   */
  indicatorLayoutId?: string;
}

/**
 * `/team` route bar — the title, the view strip, and the way to add an agent.
 *
 * @param props - See {@link TeamHeaderProps}; the route passes none.
 */
export function TeamHeader({ indicatorLayoutId = 'team-view-tabs' }: TeamHeaderProps = {}) {
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
          indicatorLayoutId={indicatorLayoutId}
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
          // But it does not get to be the SMALLEST thing in the row. `size="xs"`
          // is 24px, which left the bar's only write action a shorter target
          // than the tabs beside it (35px) once it lost its label. Square it to
          // the tabs' height instead: same row, same reach.
          className={cn(isMobile && 'h-[35px] w-[35px] p-0')}
        >
          <Plus />
          {!isMobile && 'New Agent'}
        </Button>
      }
    />
  );
}
