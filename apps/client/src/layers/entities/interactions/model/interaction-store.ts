/**
 * When YOU last opened a thing — one store, one key space, every kind.
 *
 * The sidebar's Today zone is ordered by the operator's own attention and never
 * by an agent's (spec `sidebar-now-today-library` BC-16), which needs a fact no
 * server has: the moment this person last looked at this conversation. That is
 * what lives here.
 *
 * **One key space for every kind** (`session:<id>`, `room:<id>`,
 * `agent:<path>`) because the alternative is what the cockpit already grew
 * once: a localStorage key that only knew about agents
 * (`dorkos:agent-frecency-v2`), so ⌘K could rank agents by use and could rank
 * nothing else. P3 retires that key into this store and adds frecency scoring
 * on top of the same records; nothing here changes shape when it does.
 *
 * **Why it persists, when the spec's prefs table says "not persisted".** That
 * table is about `~/.dork/config.json` — the server-held prefs that follow you
 * between machines — and it calls this timestamp "a per-device notion by
 * definition". A per-device notion still has to survive a page reload, or
 * Today's order resets to nothing every time the tab is refreshed. So it is
 * local to this browser and durable within it.
 *
 * @module entities/interactions/model/interaction-store
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The kinds of thing an operator can open, and so the kinds this store keys.
 *
 * Deliberately the three the sidebar and ⌘K both speak. A fourth would need a
 * row grammar to render it, which is the real gate on adding one.
 */
export type InteractionKind = 'session' | 'room' | 'agent';

/**
 * The key one interaction record lives under: `<kind>:<id>`.
 *
 * Built here rather than spelled at each call site, so a reader can never look
 * in an entry no writer fills — the same discipline `sessionKeys` applies to
 * the query cache.
 *
 * @param kind - What sort of thing was opened.
 * @param id - Its stable identity: a session id, a room id, an agent's
 *   `projectPath`.
 */
export function interactionKey(kind: InteractionKind, id: string): string {
  return `${kind}:${id}`;
}

/** What this store remembers about one thing the operator has opened. */
export interface InteractionRecord {
  /**
   * When this person last opened it, epoch milliseconds.
   *
   * Epoch ms rather than an ISO string because every consumer compares it to
   * another number, and a store that hands out strings makes each of them parse.
   */
  userLastOpenedAt: number;
}

/** What the store holds. */
interface InteractionState {
  /** {@link interactionKey} → what is known about that thing. */
  records: Record<string, InteractionRecord>;
}

/** Ways the record set changes. */
interface InteractionActions {
  /**
   * Record that the operator just opened something.
   *
   * @param kind - What sort of thing was opened.
   * @param id - Its stable identity.
   * @param at - The instant, epoch ms. Defaults to now; passed explicitly by
   *   tests and by any caller replaying a known moment, so the clock stays the
   *   caller's.
   */
  recordOpened: (kind: InteractionKind, id: string, at?: number) => void;
  /** Forget everything. Test seam and the "clear local data" path. */
  reset: () => void;
}

/**
 * The interaction store.
 *
 * Exported whole (rather than only through hooks) because the sidebar's state
 * assembly reads it outside React in tests, and because P3's frecency layer
 * extends the same records rather than opening a second store beside it.
 */
export const useInteractionStore = create<InteractionState & InteractionActions>()(
  persist(
    (set) => ({
      records: {},
      recordOpened: (kind, id, at) =>
        set((state) => ({
          records: {
            ...state.records,
            [interactionKey(kind, id)]: { userLastOpenedAt: at ?? Date.now() },
          },
        })),
      reset: () => set({ records: {} }),
    }),
    { name: 'dorkos:interactions-v1' }
  )
);

/**
 * Every record, keyed by {@link interactionKey} — the shape the sidebar model
 * takes as an input.
 *
 * A selector rather than a second copy: the model wants the whole map at once
 * (it orders a list with it), and handing it the store's own object keeps the
 * memo it is wrapped in honest — the map's identity changes exactly when a
 * record does.
 */
export function useInteractionRecords(): Record<string, InteractionRecord> {
  return useInteractionStore((state) => state.records);
}

/**
 * When the operator last opened one thing, epoch ms, or `undefined` when they
 * never have.
 *
 * `undefined` and not `0`: "never opened" and "opened at the epoch" are
 * different facts, and only one of them is ever true.
 *
 * @param kind - What sort of thing.
 * @param id - Its stable identity.
 */
export function useLastOpenedAt(kind: InteractionKind, id: string): number | undefined {
  return useInteractionStore((state) => state.records[interactionKey(kind, id)]?.userLastOpenedAt);
}
