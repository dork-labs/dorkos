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
 * beside the same records; nothing here changes shape when it does.
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
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * The kinds of thing an operator can open, and so the kinds this store keys.
 *
 * Deliberately the three the sidebar and ⌘K both speak. A fourth would need a
 * row grammar to render it, which is the real gate on adding one.
 */
export type InteractionKind = 'session' | 'room' | 'agent';

/**
 * {@link interactionKey} → when the operator last opened it, **ISO-8601**.
 *
 * **The unit is part of the contract and is checked by the compiler.** The
 * sidebar model declares `SidebarState.interactions` as this exact type and
 * parses each value with `Date.parse`. Epoch milliseconds would sail through
 * that as a `string` and parse to `NaN`, which the model turns into "no
 * interaction time" — collapsing Today to alphabetical order with nothing
 * thrown and no test red. So the two ends share one named type rather than two
 * agreeing comments.
 */
export type InteractionTimestamps = Readonly<Record<string, string>>;

/**
 * How many records this store keeps.
 *
 * Growth is otherwise monotonic and includes rows for sessions that no longer
 * exist: 5,000 records measure ~400KB, against a localStorage budget of a few
 * megabytes shared with everything else the cockpit keeps. Five hundred is far
 * more than the recall window either consumer has — Today shows eight rows and
 * ⌘K ranks what you actually use — and the cap lands now, before P3 puts
 * frecency histories on the same records and makes each one bigger.
 */
export const MAX_INTERACTION_RECORDS = 500;

/**
 * A localStorage that cannot take the app down when it is full.
 *
 * `persist` writes inside the `set` call, so an unguarded `QuotaExceededError`
 * propagates out of whatever triggered it — and the only trigger here is
 * clicking a row, which would turn a full quota into a crash on navigation.
 * The same shape as `use-agent-frecency.ts`' write path: degrade to
 * memory-only for this session rather than fail the interaction.
 */
const guardedLocalStorage = {
  getItem: (name: string): string | null => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Quota exhausted, or storage disabled. The in-memory records stay
      // correct for this session; only their durability is lost.
    }
  },
  removeItem: (name: string): void => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Same rationale as setItem.
    }
  },
};

/** What the store holds. */
interface InteractionState {
  /** When the operator last opened each thing, ISO-8601. */
  opened: InteractionTimestamps;
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

/**
 * The most recent {@link MAX_INTERACTION_RECORDS} entries of a record map.
 *
 * Oldest-first eviction, because the whole value of a record is its recency:
 * the entry about to be dropped is the one neither consumer would have ranked
 * or shown anyway.
 *
 * @param opened - The map to bound.
 */
function prune(opened: Record<string, string>): Record<string, string> {
  const keys = Object.keys(opened);
  if (keys.length <= MAX_INTERACTION_RECORDS) return opened;
  const kept = keys
    .sort((a, b) => Date.parse(opened[b] ?? '') - Date.parse(opened[a] ?? ''))
    .slice(0, MAX_INTERACTION_RECORDS);
  return Object.fromEntries(kept.map((key) => [key, opened[key] as string]));
}

/**
 * The interaction store.
 *
 * Exported whole (rather than only through hooks) because the sidebar's state
 * assembly reads it outside React in tests, and because P3's frecency layer
 * extends the same store rather than opening a second one beside it.
 */
export const useInteractionStore = create<InteractionState & InteractionActions>()(
  persist(
    (set) => ({
      opened: {},
      recordOpened: (kind, id, at) =>
        set((state) => ({
          opened: prune({
            ...state.opened,
            [interactionKey(kind, id)]: new Date(at ?? Date.now()).toISOString(),
          }),
        })),
      reset: () => set({ opened: {} }),
    }),
    {
      name: 'dorkos:interactions-v1',
      storage: createJSONStorage(() => guardedLocalStorage),
      partialize: (state) => ({ opened: state.opened }),
    }
  )
);

/**
 * Every interaction timestamp, keyed by {@link interactionKey} — exactly the
 * shape `SidebarState.interactions` takes.
 *
 * A selector rather than a derived copy: the model wants the whole map at once
 * (it orders a list with it), and handing it the store's own object keeps the
 * memo it is wrapped in honest — the map's identity changes exactly when a
 * record does, and an activity event that changes nothing here produces no new
 * object.
 */
export function useInteractionTimestamps(): InteractionTimestamps {
  return useInteractionStore((state) => state.opened);
}

/**
 * When the operator last opened one thing, ISO-8601, or `undefined` when they
 * never have.
 *
 * `undefined` and not the epoch: "never opened" and "opened at midnight in
 * 1970" are different facts, and only one of them is ever true.
 *
 * @param kind - What sort of thing.
 * @param id - Its stable identity.
 */
export function useLastOpenedAt(kind: InteractionKind, id: string): string | undefined {
  return useInteractionStore((state) => state.opened[interactionKey(kind, id)]);
}
