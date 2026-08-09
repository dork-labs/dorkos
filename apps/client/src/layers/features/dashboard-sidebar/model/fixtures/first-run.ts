/**
 * Day one: DorkBot and #team, four agents found on disk, nothing done yet.
 *
 * What this fixture is for: Getting started occupying Now's slot, a Library
 * that is not empty because the install seeded it, and a Today with nothing in
 * it at all.
 *
 * **Read it, never edit it.** Several tasks consume these four files in
 * parallel; a variant belongs in the test that needs it, built with a spread
 * (`{ ...firstRun, prefs: { ...firstRun.prefs, … } }`), so one task's tweak can
 * never move another task's expectations.
 *
 * @module features/dashboard-sidebar/model/fixtures/first-run
 */
import type { SidebarState } from '../sidebar-state';
import { agent, emptyState, prefs, room } from './factories';

/** The day-one journey. */
export const firstRunFixture: SidebarState = emptyState({
  agents: [agent('/Users/dev/.dork/agents/dorkbot', { isSystem: true, attention: 'fresh' })],
  displayNames: { '/Users/dev/.dork/agents/dorkbot': 'DorkBot' },
  rooms: [room({ id: 'room-team', kind: 'channel', title: 'team', wellKnown: 'team' })],
  prefs: prefs(),
  journey: {
    discoveredUnregisteredPaths: [
      '/Users/dev/code/tangerine',
      '/Users/dev/code/cardamom',
      '/Users/dev/code/saffron',
      '/Users/dev/code/juniper',
    ],
    nonSystemAgentCount: 0,
    hasEverStartedSession: false,
    hasPostedInTeam: false,
    hasDorkBotSession: false,
  },
});
