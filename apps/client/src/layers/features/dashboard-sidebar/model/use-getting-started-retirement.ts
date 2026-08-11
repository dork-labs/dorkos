/**
 * A Getting-started suggestion the operator has answered never comes back
 * (BC-13, BC-14).
 *
 * @module features/dashboard-sidebar/model/use-getting-started-retirement
 */
import { useEffect, useMemo, useRef } from 'react';
import { retireSuggestion, useUpdateSidebarPrefs } from '@/layers/entities/config';
import type { SuggestionId } from './build-sidebar-model';
import { buildGettingStarted } from './rules/build-getting-started';
import type { SidebarState } from './sidebar-state';

/**
 * Retire every suggestion that WAS applicable and no longer is.
 *
 * **Satisfaction is observed as a transition, not tested by a second predicate.**
 * BC-12's table gives each suggestion one condition; writing its inverse out
 * again as a "retires when" would be the same rule in two places, and the two
 * would eventually disagree. Watching a suggestion leave the list says exactly
 * what retirement means — it applied, the operator did the thing, it stopped
 * applying — and it cannot fire for a suggestion nobody was ever shown, which
 * is the failure that would burn a piece of onboarding permanently.
 *
 * Three things this deliberately does not do:
 *
 * - It does not read the zone. Getting started is suppressed whenever Heads up has
 *   a real signal (BC-4), so a suggestion "disappearing" from the rendered tree
 *   is not evidence of anything. It reads the rule directly.
 * - It does nothing at all while the journey facts are unresolved, and it
 *   forgets what it saw when they go back to unresolved. Every fact's loading
 *   placeholder means "satisfied", so a cold load looks exactly like an
 *   operator finishing all five at once.
 * - It never un-retires. `retireSuggestion` is one-way, and this only ever adds.
 *
 * @param state - The sidebar's snapshot, holding the journey facts and prefs.
 * @param isResolved - Whether those facts are real yet ({@link useJourneyFacts}).
 */
export function useGettingStartedRetirement(state: SidebarState, isResolved: boolean): void {
  const { update } = useUpdateSidebarPrefs();
  const applicable = useMemo(
    () =>
      isResolved
        ? buildGettingStarted(state)
            .map((row) => (row.target.kind === 'suggestion' ? row.target.suggestionId : null))
            .filter((id): id is SuggestionId => id !== null)
        : null,
    [state, isResolved]
  );

  // What was applicable on the previous resolved render. `null` means "nothing
  // to compare against" — either the first resolved render or a lapse back to
  // unresolved — and a comparison is the only thing that can retire anything.
  const previous = useRef<SuggestionId[] | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = applicable;
    if (before === null || applicable === null) return;
    const satisfied = before.filter((id) => !applicable.includes(id));
    if (satisfied.length === 0) return;
    update((prev) => satisfied.reduce((acc, id) => retireSuggestion(acc, id), prev));
  }, [applicable, update]);
}
