import type {
  LocalBrowserPersonState,
  LocalBrowserPersonStateSchema,
} from '@dorkos/shared/local-browser';

/** What the app's own parse of a person's state returns: the schema, not the interface. */
type ParsedPersonState = ReturnType<typeof LocalBrowserPersonStateSchema.parse>;

/**
 * The Agent browser's state as a person's controls read it, for specs that fake
 * the browser's own routes (DOR-4700).
 *
 * Typed against both the shared interface and the schema the app parses every
 * answer with, so a field either starts requiring fails
 * `pnpm --filter @dorkos/e2e typecheck` on the PR. Faked as a loose object, a
 * missing field only showed up in the merge queue, where the app rejected the
 * state and took its "couldn't read" path (DOR-4433's `takenOver`).
 */
const NOTHING_OPEN: LocalBrowserPersonState & ParsedPersonState = {
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
 * A complete browser state: nothing open, with `fields` laid over it. A field
 * given as `undefined` keeps its closed value, so no spec can drop one by accident.
 *
 * @param fields - What this spec's browser shows; everything else stays closed.
 */
export function fakeBrowserState(
  fields: Partial<LocalBrowserPersonState> = {}
): LocalBrowserPersonState {
  const given = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<LocalBrowserPersonState>;
  return { ...NOTHING_OPEN, tabs: [], ...given };
}
