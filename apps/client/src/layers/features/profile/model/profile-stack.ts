/**
 * The push-in stack: what a profile can have on top of it, and how a home
 * moves through it (spec `profile-unification` §1.3).
 *
 * The state is data, not a store, because the two homes hold it in two places:
 * the sheet keeps it in the URL (`?profile=` + `?profilePage=`), and the docked
 * panel will keep it in a Zustand store (W2.3). Both drive the same reducers
 * below, so "what push means" is written once.
 *
 * @module features/profile/model/profile-stack
 */

/**
 * Every page a profile row can push.
 *
 * The whole set is named here even though this slice only registers some of
 * them (`ui/pages/registry.ts`): the row model is the contract with §1.4 and is
 * complete from the first slice, so W2.2 registers components rather than
 * re-deriving which rows exist.
 */
export type ProfilePageId =
  | 'about'
  | 'sessions'
  | 'tasks'
  | 'rooms'
  | 'skills'
  | 'tools'
  | 'connections'
  | 'instructions'
  | 'boundaries'
  | 'manages'
  | 'appearance'
  | 'name'
  | 'handle'
  | 'photo';

/** Every value {@link ProfilePageId} admits, for parsing one off a URL. */
const PROFILE_PAGE_IDS: readonly ProfilePageId[] = [
  'about',
  'sessions',
  'tasks',
  'rooms',
  'skills',
  'tools',
  'connections',
  'instructions',
  'boundaries',
  'manages',
  'appearance',
  'name',
  'handle',
  'photo',
];

/**
 * Read a `?profilePage=` value as a page id, or `null` when it names none.
 *
 * A link carrying a page this build has never heard of lands on the root rather
 * than on nothing — the same self-healing the stale `?profile=` link gets.
 *
 * @param raw - The raw search-param value.
 * @returns The page id, or `null`.
 */
export function asProfilePageId(raw: string | null | undefined): ProfilePageId | null {
  if (!raw) return null;
  return PROFILE_PAGE_IDS.includes(raw as ProfilePageId) ? (raw as ProfilePageId) : null;
}

/**
 * One thing pushed on top of a profile: a page of it, or a whole other profile
 * (the owner above it, an agent it manages).
 */
export type ProfileStackEntry =
  | { kind: 'page'; page: ProfilePageId }
  | { kind: 'profile'; memberId: string };

/** A profile and everything pushed on top of it. */
export interface ProfileStackState {
  /** Whose profile is at the bottom of the stack. */
  rootMemberId: string;
  /** What sits on top of it, oldest first. */
  entries: ProfileStackEntry[];
}

/**
 * The stack a home starts with — one identity, nothing on top.
 *
 * @param rootMemberId - Whose profile this is.
 * @param entries - What is already pushed (a deep link's page).
 */
export function profileStack(
  rootMemberId: string,
  entries: ProfileStackEntry[] = []
): ProfileStackState {
  return { rootMemberId, entries };
}

/**
 * Push an entry.
 *
 * A profile entry **clears the pages above it**: pushing an owner from inside
 * the Sessions page means you are looking at the owner, not at their sessions.
 *
 * @param stack - The stack to push onto.
 * @param entry - What to push.
 */
export function pushEntry(stack: ProfileStackState, entry: ProfileStackEntry): ProfileStackState {
  if (entry.kind === 'profile') {
    const trimmed = stack.entries.filter((row) => row.kind === 'profile');
    return { ...stack, entries: [...trimmed, entry] };
  }
  return { ...stack, entries: [...stack.entries, entry] };
}

/**
 * Pop the top entry. Popping an empty stack is a no-op — the root has no back.
 *
 * @param stack - The stack to pop.
 */
export function popEntry(stack: ProfileStackState): ProfileStackState {
  if (stack.entries.length === 0) return stack;
  return { ...stack, entries: stack.entries.slice(0, -1) };
}

/**
 * Which page is showing, or `null` when the stack is on a profile root.
 *
 * Only the **top** entry counts: a page under a chained profile is not on
 * screen, it is history.
 *
 * @param stack - The stack to read.
 */
export function currentPage(stack: ProfileStackState): ProfilePageId | null {
  const top = stack.entries.at(-1);
  return top?.kind === 'page' ? top.page : null;
}

/**
 * Whose profile is one level down, or `null` when the current one is the root.
 *
 * What the back bar names. A chained profile — an owner, an agent somebody
 * manages — is a frame like any other, so it needs a visible way back and the
 * name of the place it goes; only the browser's own Back button knew this
 * before.
 *
 * @param stack - The stack to read.
 */
export function beneathMemberId(stack: ProfileStackState): string | null {
  const profiles = stack.entries.filter((entry) => entry.kind === 'profile');
  if (profiles.length === 0) return null;
  return profiles.at(-2)?.memberId ?? stack.rootMemberId;
}

/**
 * What the stack is showing, as one string — the frame's identity.
 *
 * Pages keep their bare id because that is what the row that pushed one is
 * tagged with (`data-profile-return`, restored on pop); a chained profile is
 * qualified so the two sets can never collide.
 *
 * @param stack - The stack to read.
 * @returns The page id, `profile:<member id>`, or `null` for the root.
 */
export function stackFrameKey(stack: ProfileStackState): string | null {
  const top = stack.entries.at(-1);
  if (top === undefined) return null;
  return top.kind === 'page' ? top.page : profileFrameKey(top.memberId);
}

/**
 * The frame key a chained profile is drawn under.
 *
 * Exported so the control that pushes one can tag itself with the same string
 * and take focus back when it is popped.
 *
 * @param memberId - Whose profile is being pushed.
 */
export function profileFrameKey(memberId: string): string {
  return `profile:${memberId}`;
}

/**
 * Whose profile the stack is currently about — the last profile pushed onto it,
 * or the root when none has been.
 *
 * This is what a home resolves against the roster before rendering: the member
 * a page belongs to is the profile below it, not the root underneath everything.
 *
 * @param stack - The stack to read.
 */
export function stackMemberId(stack: ProfileStackState): string {
  for (let i = stack.entries.length - 1; i >= 0; i--) {
    const entry = stack.entries[i];
    if (entry.kind === 'profile') return entry.memberId;
  }
  return stack.rootMemberId;
}
