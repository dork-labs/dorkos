import { useMemo, useState } from 'react';
import { useIsRestoring } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Button, PageContainer } from '@/layers/shared/ui';
import {
  DEFAULT_TEAM_FILTERS,
  filterTeamMembers,
  useTeamRoster,
  type TeamRosterFilters,
} from '@/layers/entities/team';
import { useProfileDeepLink } from '@/layers/shared/model';
import { AgentGhostRows } from '@/layers/features/agents-list';
import {
  TeamRosterGrid,
  TeamRosterSkeleton,
  TeamRosterToolbar,
  TeamRosterWarnings,
} from '@/layers/features/team-roster';

/** The page driven by something outside it — in practice, the route's search params. */
interface ControlledTeamPageProps {
  /**
   * What the roster is filtered by.
   *
   * The route owns this once `/team` exists: the whole search-param object goes
   * in (extra params ride along untouched) and `onFiltersChange` navigates.
   */
  filters: TeamRosterFilters;
  /** Called with a partial update whenever a control changes. */
  onFiltersChange: (patch: Partial<TeamRosterFilters>) => void;
}

/** The page keeping its own filter state — a test, the playground, no router. */
interface UncontrolledTeamPageProps {
  filters?: never;
  onFiltersChange?: never;
}

/**
 * Controlled or uncontrolled, and never half of each.
 *
 * A union rather than two optional props: passing `filters` without
 * `onFiltersChange` would read from outside and write to state nothing renders,
 * so every control would look broken. The compiler refuses that arrangement
 * instead of the page discovering it at runtime.
 */
export type TeamPageProps = ControlledTeamPageProps | UncontrolledTeamPageProps;

/**
 * The Team page: every person and agent on this install, in one roster.
 *
 * A widget because it composes several features — the cards and controls are
 * `features/team-roster`, the no-agents state is `features/agents-list`, and
 * the roster itself is `entities/team`.
 *
 * Filtering, grouping and search all run over the one payload already in the
 * cache: the roster is bounded by the people and agents on a single machine, so
 * a request per chip would buy nothing and cost a flicker.
 *
 * **The roster is never empty.** With no agents registered, the person reading
 * the page is still on it, so their card renders above the invitation to bring
 * projects in rather than instead of it.
 */
export function TeamPage({ filters, onFiltersChange }: TeamPageProps) {
  const [ownFilters, setOwnFilters] = useState<TeamRosterFilters>(DEFAULT_TEAM_FILTERS);
  const activeFilters = filters ?? ownFilters;

  // Keyed on `filters`, the same prop the read above is keyed on, so reads and
  // writes can never disagree about who owns the state. The union makes the
  // other branch unreachable from TypeScript, and this keeps it unreachable at
  // runtime for a caller that got there through a cast.
  const patchFilters = (patch: Partial<TeamRosterFilters>) => {
    if (filters !== undefined) onFiltersChange(patch);
    else setOwnFilters((current) => ({ ...current, ...patch }));
  };

  // The roster rows this page draws ARE the drawer's own id space, so a card
  // hands its `member.id` straight over with nothing to map.
  const { open: openProfile } = useProfileDeepLink();
  const { data, isLoading: isFetchingRoster, isError, refetch } = useTeamRoster();
  // "The read has not settled" is not "there is nobody" (DOR-1419). `isLoading`
  // is `isPending && isFetching`. While `PersistQueryClientProvider` restores
  // the persisted cache (`shared/lib/query-persister.ts`), TanStack PAUSES
  // every query, so `isFetching` reads false while `data` is still undefined —
  // `isLoading` comes back FALSE with an empty roster in hand, and the grid
  // below renders "Nobody to show yet." for a beat before the real roster
  // lands. The same defect `useOnboarding` fixed for the onboarding overlay
  // (DOR-1365 §3.2). `useIsRestoring` is false wherever there is no
  // persister — the Obsidian embed included — so this costs those surfaces
  // nothing.
  const isRestoring = useIsRestoring();
  const isLoading = isFetchingRoster || isRestoring;
  const roster = useMemo(() => data?.members ?? [], [data]);
  const visible = useMemo(() => filterTeamMembers(roster, activeFilters), [roster, activeFilters]);
  const people = useMemo(() => roster.filter((member) => member.kind === 'human'), [roster]);
  const hasAgents = roster.some((member) => member.kind === 'agent');
  // Whether a control is hiding anyone. "Nothing matched" and "there is nobody
  // here" are different facts, and one of them is a lie when a filter is on.
  const isNarrowed =
    activeFilters.kind !== 'all' ||
    activeFilters.owner !== undefined ||
    (activeFilters.q ?? '') !== '';

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="bg-destructive/10 rounded-xl p-3">
          <TriangleAlert aria-hidden className="text-destructive size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load your team</p>
          <p className="text-muted-foreground text-xs">
            The DorkOS server did not answer. Check that it is still running.
          </p>
        </div>
        <Button size="sm" onClick={() => void refetch()} className="mt-1">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <PageContainer width="full" className="flex flex-col gap-4">
      <TeamRosterWarnings warnings={data?.warnings} />
      <TeamRosterToolbar filters={activeFilters} onFiltersChange={patchFilters} people={people} />
      {/* The skeleton replaces only the roster below the toolbar — the same
          shape `PackageGrid` uses for `PackageLoadingSkeleton` — so the
          toolbar and warnings slot stay mounted through the load and nothing
          above the roster appears out from under it (DOR-1752 finding 6.5).
          An early return here, before the toolbar, would remount it once the
          roster lands and everything below it would jump. */}
      {isLoading ? (
        <TeamRosterSkeleton />
      ) : visible.length > 0 ? (
        <TeamRosterGrid
          members={visible}
          roster={roster}
          grouped={activeFilters.group === 'manager'}
          onSelectOwner={(ownerId) => patchFilters({ owner: ownerId })}
          onOpenProfile={openProfile}
        />
      ) : (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {isNarrowed ? 'Nobody here matches that.' : 'Nobody to show yet.'}
        </p>
      )}
      {/* Below the roster, never instead of it — and only when there is a
          roster to be below. A truly empty payload means the roster could not
          be read (the banner above says so), and inviting someone to import
          projects would be answering a question they did not ask with a button
          that cannot help. Held back while loading too, so it cannot flash on
          before the real roster says whether there are agents at all. */}
      {!isLoading && roster.length > 0 && !hasAgents && (
        <div className="flex justify-center py-6">
          <AgentGhostRows />
        </div>
      )}
    </PageContainer>
  );
}
