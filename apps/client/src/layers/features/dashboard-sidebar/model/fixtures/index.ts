/**
 * The four journeys the sidebar is designed against, as complete
 * {@link SidebarState} snapshots.
 *
 * They are a deliverable, not test scaffolding: the same four drive the model's
 * table tests, the Dev Playground's showcases and the browser tests, so what a
 * reviewer looks at and what CI asserts are the same states.
 *
 * **These files are read, never edited.** Several tasks consume them in
 * parallel. A test or showcase that needs a variant builds it locally with a
 * spread — `{ ...busyFixture, attention: [] }` — so nobody's tweak becomes
 * somebody else's failing expectation.
 *
 * @module features/dashboard-sidebar/model/fixtures
 */
import { busyFixture } from './busy';
import { firstRunFixture } from './first-run';
import { powerFixture } from './power';
import { quietFixture } from './quiet';

export { firstRunFixture } from './first-run';
export { quietFixture } from './quiet';
export { busyFixture } from './busy';
export { powerFixture } from './power';
export {
  FIXTURE_NOW,
  HOUR,
  MINUTE,
  agent,
  emptyState,
  hoursAgo,
  person,
  prefs,
  room,
  session,
  thread,
} from './factories';

/**
 * All four, in journey order, with the names a showcase or a table test prints.
 *
 * Iterating this is what makes "every fixture" assertions honest: a fifth
 * journey added here is immediately covered by every contract test that walks
 * it, rather than by whichever ones somebody remembered to update.
 */
export const SIDEBAR_FIXTURES = [
  { name: 'first-run', state: firstRunFixture },
  { name: 'quiet', state: quietFixture },
  { name: 'busy', state: busyFixture },
  { name: 'power', state: powerFixture },
] as const;
