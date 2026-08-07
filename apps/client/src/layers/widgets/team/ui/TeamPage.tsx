import { useMemo, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import {
  DEFAULT_TEAM_FILTERS,
  filterTeamMembers,
  useTeamRoster,
  type TeamRosterFilters,
} from '@/layers/entities/team';
import { AgentGhostRows } from '@/layers/features/agents-list';
import {
  TeamRosterGrid,
  TeamRosterToolbar,
  TeamRosterWarnings,
} from '@/layers/features/team-roster';

export interface TeamPageProps {
  /**
   * What the roster is filtered by, when something outside owns that state.
   *
   * The route owns it once `/team` exists: the whole search-param object goes
   * in here (extra params ride along untouched) and {@link TeamPageProps.onFiltersChange}
   * navigates. Left out, the page keeps the state itself, which is what makes
   * it renderable in a test and in the playground without a router.
   */
  filters?: TeamRosterFilters;
  /** Called with a partial update whenever a control changes. */
  onFiltersChange?: (patch: Partial<TeamRosterFilters>) => void;
}

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

  const patchFilters = (patch: Partial<TeamRosterFilters>) => {
    if (onFiltersChange) onFiltersChange(patch);
    else setOwnFilters((current) => ({ ...current, ...patch }));
  };

  const { data, isLoading, isError, refetch } = useTeamRoster();
  const roster = useMemo(() => data?.members ?? [], [data]);
  const visible = useMemo(() => filterTeamMembers(roster, activeFilters), [roster, activeFilters]);
  const people = useMemo(() => roster.filter((member) => member.kind === 'human'), [roster]);
  const hasAgents = roster.some((member) => member.kind === 'agent');

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Loader2
          aria-label="Loading the team"
          className="text-muted-foreground size-5 animate-spin"
        />
      </div>
    );
  }

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
    <div data-slot="team-page" className="flex h-full flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <TeamRosterWarnings warnings={data?.warnings} />
      <TeamRosterToolbar filters={activeFilters} onFiltersChange={patchFilters} people={people} />
      {visible.length > 0 ? (
        <TeamRosterGrid
          members={visible}
          roster={roster}
          grouped={activeFilters.group === 'manager'}
          onSelectOwner={(ownerId) => patchFilters({ owner: ownerId })}
        />
      ) : (
        <p className="text-muted-foreground py-8 text-center text-sm">Nobody here matches that.</p>
      )}
      {/* Below the roster, never instead of it. */}
      {!hasAgents && (
        <div className="flex justify-center py-6">
          <AgentGhostRows />
        </div>
      )}
    </div>
  );
}
