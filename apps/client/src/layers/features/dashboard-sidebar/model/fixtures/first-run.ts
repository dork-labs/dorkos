/**
 * Day one: DorkBot and #team, and nothing said to anybody yet.
 *
 * What this fixture is for: a list that is not empty because the install
 * seeded #team, and a Direct messages section whose only row is the way to
 * start a conversation with an agent.
 *
 * **Read it, never edit it.** Several suites consume these four files; a
 * variant belongs in the test that needs it, built with a spread
 * (`{ ...firstRun, prefs: { ...firstRun.prefs, … } }`), so one test's tweak can
 * never move another's expectations.
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
});
