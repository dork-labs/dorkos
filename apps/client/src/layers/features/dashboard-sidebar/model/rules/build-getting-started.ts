/**
 * Getting started — computed suggestions, never a checklist (BC-12→BC-14).
 *
 * @module features/dashboard-sidebar/model/rules/build-getting-started
 */
import type { SidebarIconId, SidebarRowModel, SuggestionId } from '../build-sidebar-model';
import type { JourneyFacts, SidebarState } from '../sidebar-state';
import { rowKey } from './targets';

/** One suggestion's definition: when it is true, and what it says. */
interface Suggestion {
  /** Its id, which is also its `reason` and its retirement token. */
  id: SuggestionId;
  /** The mark it draws. */
  icon: SidebarIconId;
  /** Whether it is worth saying right now, given what is true. */
  applies: (facts: JourneyFacts) => boolean;
  /** What it says, in the operator's own numbers. */
  label: (facts: JourneyFacts) => string;
}

/**
 * The five suggestions, in the order they are offered.
 *
 * **`agents-found` and `add-agent` are mutually exclusive**, and the second is
 * a fallback rather than an alternative: if discovery found agents on this
 * machine, "add your first agent" is telling somebody to do work the product
 * already did.
 *
 * Each predicate reads a fact rather than a completion flag, which is what
 * makes this a computed zone. What is permanent is retirement, and that lives
 * in prefs, not here.
 */
const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'suggestion:agents-found',
    icon: 'discovery',
    applies: (f) => f.discoveredUnregisteredPaths.length > 0,
    label: (f) =>
      f.discoveredUnregisteredPaths.length === 1
        ? 'Meet the agent we found'
        : `Meet the ${f.discoveredUnregisteredPaths.length} agents we found`,
  },
  {
    id: 'suggestion:add-agent',
    icon: 'add-agent',
    applies: (f) => f.discoveredUnregisteredPaths.length === 0 && f.nonSystemAgentCount === 0,
    label: () => 'Add your first agent',
  },
  {
    id: 'suggestion:first-session',
    icon: 'first-session',
    applies: (f) => f.nonSystemAgentCount > 0 && !f.hasEverStartedSession,
    label: () => 'Start your first session',
  },
  {
    id: 'suggestion:say-hi-team',
    icon: 'team',
    applies: (f) => !f.hasPostedInTeam,
    label: () => 'Say hi in #team',
  },
  {
    id: 'suggestion:ask-dorkbot',
    icon: 'dorkbot',
    applies: (f) => !f.hasDorkBotSession,
    label: () => 'Ask DorkBot anything',
  },
];

/**
 * The suggestions worth showing right now.
 *
 * **Retirement is permanent and beats every predicate.** A suggestion the
 * operator has satisfied is written into `prefs.gettingStarted.retired[]` and
 * never returns, even when its predicate becomes true again — deleting an agent
 * or cleaning up a session must not re-open a piece of onboarding somebody has
 * already lived through. When every one of them is retired the list is empty,
 * the zone is absent, and it does not come back.
 *
 * @param state - The snapshot.
 */
export function buildGettingStarted(state: SidebarState): SidebarRowModel[] {
  const retired = new Set(state.prefs.gettingStarted.retired);
  const rows: SidebarRowModel[] = [];
  for (const suggestion of SUGGESTIONS) {
    if (retired.has(suggestion.id)) continue;
    if (!suggestion.applies(state.journey)) continue;
    const target = { kind: 'suggestion', suggestionId: suggestion.id } as const;
    rows.push({
      key: rowKey(target),
      target,
      glyph: { kind: 'icon', icon: suggestion.icon },
      primary: suggestion.label(state.journey),
      status: 'idle',
      reservesVerbLine: false,
      unread: { tier: 'none' },
      muted: false,
      draggable: false,
      actions: ['open'],
      reason: suggestion.id,
    });
  }
  return rows;
}
