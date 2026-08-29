/**
 * What the explorer hides, and what it floats — the two rules that turn a raw
 * directory into a listing worth reading (spec `project-rooms` §3.9).
 *
 * Both are about the same thing. A project's root is mostly machinery: config
 * the tools wrote for themselves, a dependency tree nobody reads, the harness
 * directories DorkOS and its agents keep. Left alone, that machinery is most of
 * what a person sees, and the two files that actually say what the project IS
 * sit under it. So the plumbing goes away by default, and the files that
 * explain the place come first.
 *
 * @module features/file-explorer/lib/listing-shape
 */
import type { ExplorerEntry } from '../model/source';

/**
 * The names hidden alongside dotfiles when hidden entries are off.
 *
 * One list, exported, because two different places need the same answer: the
 * pane filters a source that hands its listings over unfiltered, and a test
 * pins the list so it cannot drift into "whatever the filter happens to do".
 *
 * Everything here is machinery, and each entry is here for its own reason:
 * `.git` is the repository itself; `.dork`, `.claude` and `.agents` are where
 * DorkOS, Claude Code and the harness keep what they wrote for themselves; and
 * `node_modules` is a dependency tree that is read by tools and by nobody else.
 *
 * The dotfile rule covers most of these on its own — they are listed anyway, so
 * that the list reads as the whole answer rather than half of one, and so
 * `node_modules` is not the lone special case nobody remembers.
 */
export const HIDDEN_ENTRY_NAMES: readonly string[] = [
  '.git',
  '.dork',
  '.claude',
  '.agents',
  'node_modules',
];

/**
 * Whether an entry is plumbing: a dotfile, or one of
 * {@link HIDDEN_ENTRY_NAMES}.
 *
 * @param name - The entry's own name, with no directory in it.
 */
export function isHiddenEntryName(name: string): boolean {
  return name.startsWith('.') || HIDDEN_ENTRY_NAMES.includes(name);
}

/**
 * The files that float to the top of a listing.
 *
 * Both answer "what is this place?" — the one a room's members write about
 * their room, and the one a repository has always used for the same job. Matched
 * without regard to case, because a filesystem's opinion on that varies and a
 * reader's does not.
 */
export const PINNED_ENTRY_NAMES: readonly string[] = ['ROOM.md', 'README.md'];

/**
 * Whether a name is one of {@link PINNED_ENTRY_NAMES}.
 *
 * @param name - The entry's own name.
 */
export function isPinnedEntryName(name: string): boolean {
  return PINNED_ENTRY_NAMES.some((pinned) => pinned.toLowerCase() === name.toLowerCase());
}

/**
 * Drop the plumbing from a listing.
 *
 * @param entries - The directory's children.
 */
export function withoutHidden(entries: readonly ExplorerEntry[]): ExplorerEntry[] {
  return entries.filter((entry) => !isHiddenEntryName(entry.name));
}

/**
 * Float the pinned files to the top, leaving everything else exactly as the
 * source ordered it.
 *
 * **Above the directories too**, which is the one place this departs from the
 * usual folders-then-files shape. A pinned file is not competing with the
 * folders for a place in the sort; it is the thing you read before you open
 * anything, so it sits where you look first. The array's identity is preserved
 * when nothing is pinned, so a listing that has neither file costs no re-render.
 *
 * @param entries - The directory's children, already in the source's order.
 */
export function pinnedFirst(entries: readonly ExplorerEntry[]): ExplorerEntry[] {
  const pinnedCount = entries.reduce(
    (count, entry) => (entry.type === 'file' && isPinnedEntryName(entry.name) ? count + 1 : count),
    0
  );
  if (pinnedCount === 0) return entries as ExplorerEntry[];
  const pinned: ExplorerEntry[] = [];
  const rest: ExplorerEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'file' && isPinnedEntryName(entry.name)) pinned.push(entry);
    else rest.push(entry);
  }
  // Among themselves, in the order PINNED_ENTRY_NAMES declares — so a room that
  // has both puts its own ROOM.md above the README, which is the order the two
  // are meant to be read in.
  pinned.sort(
    (a, b) =>
      PINNED_ENTRY_NAMES.findIndex((n) => n.toLowerCase() === a.name.toLowerCase()) -
      PINNED_ENTRY_NAMES.findIndex((n) => n.toLowerCase() === b.name.toLowerCase())
  );
  return [...pinned, ...rest];
}
