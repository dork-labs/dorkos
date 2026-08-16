/**
 * The docked profile's own state — which agent the right panel is pointed at,
 * and how deep into that profile you have pushed (spec `profile-unification`
 * §1.6).
 *
 * The sheet keeps its stack in the URL, because a sheet is an address. The dock
 * cannot: the right panel shows one tab at a time and drops the others, so
 * flipping to Files and back would lose the page you were reading. This store is
 * that memory, and nothing more — it is deliberately not persisted and is
 * emptied when the panel closes, so a fresh open lands on the profile's root
 * rather than wherever you happened to stop last time.
 *
 * **Keyed by the agent's directory, not by member id.** The spec says "per
 * member id"; the dock cannot honour that literally, because it is bound to a
 * path (`explicitAgentPath`, which is what the tab's `visibleWhen` reads) and
 * resolves the member id from it asynchronously. A caller opening the docked
 * profile from a click has a path in hand and no id, so keying by path is what
 * lets the open be synchronous. The behaviour the spec asked for — one stack per
 * agent — is unchanged.
 *
 * @module features/profile/model/profile-store
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useAppStore } from '@/layers/shared/model';
import type { ProfilePageId, ProfileStackEntry } from './profile-stack';

/**
 * The right-panel contribution id the docked profile registers under.
 *
 * One constant rather than a string in eight files: the shortcut, the deep link,
 * the registration and every surface that opens the panel all have to name the
 * same tab, and the last rename (`agent-hub` → `profile`) is exactly the change
 * that finds the ones that drifted.
 */
export const PROFILE_PANEL_ID = 'profile';

/**
 * How many agents' docked stacks are kept at once.
 *
 * The map is already emptied when the panel closes, so this only bounds one
 * unusually long sitting — flipping between agents with the panel open — rather
 * than a leak that survives the session. Least-recently-touched goes first, the
 * same rule the per-agent right-panel layout map uses.
 */
const MAX_DOCKED_STACKS = 8;

/** One shared empty stack, so an agent nobody has pushed on costs no allocation. */
const NOTHING_PUSHED: readonly ProfileStackEntry[] = [];

/**
 * Write one agent's entries into the map, newest last, evicting the oldest past
 * {@link MAX_DOCKED_STACKS}.
 *
 * Re-inserting the touched key is what makes plain insertion order mean
 * recency — no timestamps to keep honest.
 */
function touch(
  map: Record<string, readonly ProfileStackEntry[]>,
  agentPath: string,
  entries: readonly ProfileStackEntry[]
): Record<string, readonly ProfileStackEntry[]> {
  const { [agentPath]: _replaced, ...rest } = map;
  const next: Record<string, readonly ProfileStackEntry[]> = { ...rest, [agentPath]: entries };
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_DOCKED_STACKS))) {
    delete next[stale];
  }
  return next;
}

interface ProfileStoreState {
  /** What is pushed on top of each agent's docked profile, keyed by its directory. */
  dockedEntries: Record<string, readonly ProfileStackEntry[]>;
  /**
   * Point the right panel at an agent's profile and open it.
   *
   * The one call every surface that used to open the Agent Hub now makes. It
   * does all four things that open means — which agent, which tab, the panel
   * itself, and where in the profile — because doing three of them was the shape
   * of the old bug: `openHub` alone left the dialog closing onto an unchanged
   * dashboard and the click read as having done nothing.
   *
   * Always lands on the profile's root unless a page is named, so opening a
   * profile shows you a profile.
   *
   * @param agentPath - The agent's directory.
   * @param page - A page to open straight onto, for a deep link that named one.
   */
  openProfileDocked: (agentPath: string, page?: ProfilePageId) => void;
  /**
   * The same, for an opener that is a LINK rather than a click.
   *
   * The difference is not what happens, it is what happens NEXT: a click lands
   * after the panel's layouts have hydrated and has nothing to argue with, while
   * a link is read on mount and is then overruled by the layout each agent was
   * left in — which for an agent you have never opened is "closed". So this one
   * marks the panel's open as requested, and the hydration honours it
   * (`requestedRightPanelTab`).
   *
   * @param agentPath - The agent's directory.
   * @param page - A page to open straight onto, when the link named one.
   */
  openProfileDockedFromLink: (agentPath: string, page?: ProfilePageId) => void;
  /**
   * Replace what is pushed on top of one agent's docked profile.
   *
   * Takes the whole list rather than a push/pop verb: the stack's reducers live
   * in `profile-stack.ts` and are shared with the sheet, so "what push means" is
   * written once and this store only remembers the answer.
   *
   * @param agentPath - The agent's directory.
   * @param entries - The new stack contents, oldest first.
   */
  setDockedEntries: (agentPath: string, entries: readonly ProfileStackEntry[]) => void;
  /** Forget every docked stack — the panel closed, so nothing is left open. */
  clearDockedStacks: () => void;

  /**
   * The identities the SHEET chained through to reach its current subject,
   * oldest first — everything beneath `?profile=`.
   *
   * The sheet's subject is the URL, and the URL holds one id: a chained profile
   * rewrites it and pushes history, so the browser's Back button walks the chain
   * (and must keep doing so). What the URL cannot say is that there is anything
   * underneath — so the panel had no back control of its own, and a docked panel
   * has no browser Back to fall back on. This is that missing half, and only
   * that: the subject stays the URL's, and this is reconciled against it.
   */
  sheetChain: readonly string[];
  /** Note the subject being left behind as a chained profile is opened. */
  pushSheetChain: (memberId: string) => void;
  /** Drop the deepest link — the sheet went back to it, by button or by browser. */
  popSheetChain: () => void;
  /** Forget the chain — the sheet closed, so the next open starts fresh. */
  clearSheetChain: () => void;
}

/** The docked profile's stack memory. See the module doc for what it is not. */
export const useProfileStore = create<ProfileStoreState>()(
  devtools(
    (set) => ({
      dockedEntries: {},

      openProfileDocked: (agentPath, page) => {
        set((state) => ({
          dockedEntries: touch(
            state.dockedEntries,
            agentPath,
            page ? [{ kind: 'page', page }] : NOTHING_PUSHED
          ),
        }));
        const app = useAppStore.getState();
        // Published to the app store because the tab's `visibleWhen` predicate
        // runs across the feature boundary and cannot read this store. See
        // `explicitAgentPath`'s own docs for why the ambient cwd is not an
        // honest stand-in for a click.
        app.setExplicitAgentPath(agentPath);
        app.setActiveRightPanelTab(PROFILE_PANEL_ID);
        app.setRightPanelOpen(true);
      },

      openProfileDockedFromLink: (agentPath, page) => {
        useProfileStore.getState().openProfileDocked(agentPath, page);
        // Last, deliberately: opening the panel above goes through the same
        // explicit setters a person's click does, and those CLEAR a pending
        // request — so the mark has to outlive them.
        useAppStore.getState().requestRightPanel(PROFILE_PANEL_ID);
      },

      setDockedEntries: (agentPath, entries) =>
        set((state) => ({ dockedEntries: touch(state.dockedEntries, agentPath, entries) })),

      clearDockedStacks: () => set({ dockedEntries: {} }),

      sheetChain: [],
      pushSheetChain: (memberId) =>
        set((state) => ({ sheetChain: [...state.sheetChain, memberId] })),
      popSheetChain: () => set((state) => ({ sheetChain: state.sheetChain.slice(0, -1) })),
      clearSheetChain: () => set((state) => (state.sheetChain.length ? { sheetChain: [] } : state)),
    }),
    { name: 'profile' }
  )
);

/**
 * What is pushed on top of one agent's docked profile.
 *
 * A selector rather than an inline one, so every reader shares the same empty
 * value and an agent with nothing pushed never re-renders on someone else's
 * push.
 *
 * @param agentPath - The agent's directory, or `null` when none is docked.
 */
export function useDockedEntries(agentPath: string | null): readonly ProfileStackEntry[] {
  return useProfileStore(
    (s) => (agentPath === null ? NOTHING_PUSHED : s.dockedEntries[agentPath]) ?? NOTHING_PUSHED
  );
}
