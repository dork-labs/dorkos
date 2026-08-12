/**
 * What YOU opened, when, and how often — one store, one key space, every kind.
 *
 * The sidebar's Today zone is ordered by the operator's own attention and never
 * by an agent's (spec `sidebar-now-today-library` BC-16), which needs a fact no
 * server has: the moment this person last looked at this conversation. That is
 * what lives here, beside the count of how many times they have.
 *
 * **One key space for every kind** (`session:<id>`, `room:<id>`,
 * `agent:<path>`) because the alternative is what the cockpit already grew
 * once: a localStorage key that only knew about agents
 * (`dorkos:agent-frecency-v2`), so ⌘K could rank agents by use and could rank
 * nothing else. That key is retired into this store by
 * {@link module:entities/interactions/model/legacy-frecency-migration}, and the
 * count it carried now lives on {@link InteractionState.counts} for every kind
 * rather than for one.
 *
 * **Two maps, added rather than merged.** The obvious shape is one record per
 * key holding both facts. It is not the shape here, because
 * `SidebarState.interactions` is `opened` itself — the sidebar reads the map
 * whole and parses its values — so merging would have rewritten a contract two
 * shipped phases already depend on to add a field only ⌘K reads. The two maps
 * carry the same keys and are pruned together, which is the invariant
 * {@link prune} exists to keep.
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
 *
 * **Actions and slash commands are not the fourth, and that was decided rather
 * than deferred.** ⌘K ranks them and they carry no history at all, so recording
 * them here is the obvious fix for the handicap
 * `features/command-palette/model/use-palette-items` documents — that file even
 * names this store as the escape hatch. It is not taken, because of a coupling
 * neither file can see alone: the sidebar's "While you were away…" digest
 * dissolves when the NEWEST record here moves, of whatever kind
 * (`use-digest-facts.ts`, BC-22). Recording an action would mean toggling the
 * theme from ⌘K puts away a summary of the night's work — the digest reporting
 * itself read by somebody who read nothing. The rule this store keeps is
 * therefore **a record is a place you went, not a thing you did**, and adding a
 * fourth kind means first giving the digest a way to say which kinds count.
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
 * Degrade to memory-only for this session rather than fail the interaction —
 * the same shape the retired agent-frecency key's write path used, and the
 * reason `legacy-frecency-migration.ts` guards its reads too.
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

/**
 * {@link interactionKey} → how many times the operator has opened it, ever.
 *
 * A key absent from this map has been opened zero times. It carries the same
 * keys as {@link InteractionState.opened} and is pruned with it — see the
 * module note on why the two facts are two maps.
 */
export type InteractionCounts = Readonly<Record<string, number>>;

/** What the store holds. */
interface InteractionState {
  /** When the operator last opened each thing, ISO-8601. */
  opened: InteractionTimestamps;
  /** How many times the operator has opened each thing. */
  counts: InteractionCounts;
}

/** One thing the operator has used, as a caller outside this store describes it. */
export interface InteractionUsage {
  /** The key it is recorded under — build it with {@link interactionKey}. */
  key: string;
  /** When they last opened it, epoch ms. */
  lastUsedAt: number;
  /** How many times they have opened it, ever. */
  useCount: number;
}

/** Ways the record set changes. */
interface InteractionActions {
  /**
   * Record that the operator just opened something.
   *
   * Moves the timestamp AND advances the count, because both halves of
   * frecency come from the same act and a caller that could record one without
   * the other is a caller that can put the two maps out of step.
   *
   * @param kind - What sort of thing was opened.
   * @param id - Its stable identity.
   * @param at - The instant, epoch ms. Defaults to now; passed explicitly by
   *   tests and by any caller replaying a known moment, so the clock stays the
   *   caller's.
   */
  recordOpened: (kind: InteractionKind, id: string, at?: number) => void;
  /**
   * Fold history recorded somewhere else into this store.
   *
   * **Every field takes the larger value**, and that is what makes it safe to
   * run twice: two tabs migrating the same retired key at the same time, or one
   * tab replaying a merge it already did, converge on the same records instead
   * of double-counting. Summing would not — it would inflate the count of every
   * agent a person happened to have two tabs open for.
   *
   * The only caller is the `dorkos:agent-frecency-v2` migration. It is an
   * action rather than a loop over {@link InteractionActions.recordOpened}
   * because that would stamp the migration's own clock over a history that
   * already knows when it happened.
   *
   * @param records - What was recorded elsewhere.
   */
  mergeUsage: (records: readonly InteractionUsage[]) => void;
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
 * The most recent {@link MAX_INTERACTION_RECORDS} entries of both record maps.
 *
 * Oldest-first eviction, because the whole value of a record is its recency:
 * the entry about to be dropped is the one neither consumer would have ranked
 * or shown anyway.
 *
 * **Both maps are cut on the same key set**, which is the invariant that keeps
 * them one record split in two rather than two records. A count left behind by
 * an evicted timestamp would rank a row the store no longer claims to know,
 * and it would never be evicted again because eviction reads timestamps.
 *
 * @param state - The maps to bound, already updated.
 */
function prune(state: InteractionState): InteractionState {
  const keys = Object.keys(state.opened);
  if (keys.length <= MAX_INTERACTION_RECORDS) return state;
  const kept = keys
    .sort((a, b) => Date.parse(state.opened[b] ?? '') - Date.parse(state.opened[a] ?? ''))
    .slice(0, MAX_INTERACTION_RECORDS);
  const opened: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const key of kept) {
    opened[key] = state.opened[key] as string;
    const count = state.counts[key];
    if (count !== undefined) counts[key] = count;
  }
  return { opened, counts };
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
      counts: {},
      recordOpened: (kind, id, at) =>
        set((state) => {
          const key = interactionKey(kind, id);
          return prune({
            opened: { ...state.opened, [key]: new Date(at ?? Date.now()).toISOString() },
            counts: { ...state.counts, [key]: (state.counts[key] ?? 0) + 1 },
          });
        }),
      mergeUsage: (records) =>
        set((state) => {
          if (records.length === 0) return state;
          const opened = { ...state.opened };
          const counts = { ...state.counts };
          for (const record of records) {
            const existing = Date.parse(opened[record.key] ?? '');
            if (Number.isNaN(existing) || record.lastUsedAt > existing) {
              opened[record.key] = new Date(record.lastUsedAt).toISOString();
            }
            counts[record.key] = Math.max(counts[record.key] ?? 0, record.useCount);
          }
          return prune({ opened, counts });
        }),
      reset: () => set({ opened: {}, counts: {} }),
    }),
    {
      name: 'dorkos:interactions-v1',
      storage: createJSONStorage(() => guardedLocalStorage),
      partialize: (state) => ({ opened: state.opened, counts: state.counts }),
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
 * How many times the operator has opened each thing, keyed by
 * {@link interactionKey}.
 *
 * The other half of frecency, and the half that used to exist for agents only.
 * A selector on the store's own object for the same reason
 * {@link useInteractionTimestamps} is one: the ranker wants the whole map, and
 * handing it the stored object keeps the memo above it honest.
 */
export function useInteractionCounts(): InteractionCounts {
  return useInteractionStore((state) => state.counts);
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
