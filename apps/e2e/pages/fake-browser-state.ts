import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';

/**
 * The Agent browser's state as a person's controls read it, for specs that fake
 * the browser's own routes (DOR-4700).
 *
 * Typed against the shared state, so a field the app starts requiring fails
 * `pnpm --filter @dorkos/e2e typecheck` on the PR. Faked as a loose object, a
 * missing field only showed up in the merge queue, where the app rejected the
 * state and took its "couldn't read" path (DOR-4433's `takenOver`).
 */
const NOTHING_OPEN: LocalBrowserPersonState = {
  connectionId: null,
  sessionId: null,
  mode: null,
  status: 'disconnected',
  paused: false,
  tabs: [],
  selectedTabId: null,
  revision: 0,
  preparation: null,
  signIn: null,
  handoff: null,
  takenOver: false,
};

/**
 * A complete browser state: nothing open, with `fields` laid over it.
 *
 * @param fields - What this spec's browser shows; everything else stays closed.
 */
export function fakeBrowserState(
  fields: Partial<LocalBrowserPersonState> = {}
): LocalBrowserPersonState {
  return { ...NOTHING_OPEN, ...fields };
}
