/**
 * Who wrote a path-trust copy's files (DOR-4528).
 *
 * Path trust (`extension-path-trust.ts`) lets an edit to an agent's own mini app run without a
 * card while that agent is at Full (`path-trust-edits.ts`). The level says what the agent may do;
 * it does not say which of its turns wrote the files. A turn that holds a mark (`marksHold`, a
 * stranger's words) or runs under a ceiling may not get a standing yes for new code, so an edit is
 * trusted only when it can be tied to the author's own turn that held neither.
 *
 * ## The record
 *
 * The runtime's file-tool hook notes every write aimed inside a `.dork/extensions/` folder before
 * it runs ({@link noteExtensionWrite}): the file's real path, the turn's agent, and whether the
 * turn was held. The record is in memory only, so an edit made before a restart is tied to no one.
 *
 * ## The verdict
 *
 * {@link editedByAuthor} answers for the window since the last time it was asked about the copy.
 * The edit runs only when ALL of these hold:
 *
 * - no turn of the author that held a mark ran in the window, by any tool (the shell included)
 *   and on any runtime (`live-outsider-turns.ts` counts every runtime's marked turns);
 * - at least one write in the window landed inside the copy's folder;
 * - every such write came from the author's own turn, and none of those turns was held;
 * - the record did not overflow inside the window.
 *
 * Anything else, including a write by the shell, by another runtime with no file-tool hook, or by
 * a program outside DorkOS, waits for a person. Fails closed.
 *
 * @module services/extensions/pin/path-trust-writers
 */
import path from 'node:path';
import { marksEndedSince, runningMarksOf } from '../../core/turn-power/live-outsider-turns.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import { isInsideFolder } from './extension-path-trust.js';

/** One write a file-tool hook saw aimed inside an extensions folder. */
export interface ExtensionWrite {
  /** The file's real path, symlinks resolved as far as the file exists. */
  file: string;
  /** The real path of the turn's agent home, or undefined when the turn runs as no agent. */
  agentHome: string | undefined;
  /** Whether the turn held a mark or ran under a ceiling when it wrote. */
  held: boolean;
}

/** How many writes are kept, oldest dropped first. */
const WRITE_MEMORY = 5_000;

/** The writes, oldest first, each with its place in the order they were noted. */
const writes: (ExtensionWrite & { seq: number })[] = [];

/** The place of the last write noted. A counter, not the clock: one write is in one window. */
let lastSeq = 0;

/** The place of the newest write dropped for room; a window reaching back that far is unknown. */
let droppedThrough = 0;

/**
 * Copy id → where its last window ended: the last write noted then, and the time, which a marked
 * turn's end is compared against (at or after it counts).
 */
const askedAt = new Map<string, { seq: number; at: number }>();

/** Whether a path names something inside some `.dork/extensions/` folder. */
export function isInsideAnExtensionsFolder(file: string): boolean {
  const parts = path.resolve(file).split(path.sep);
  return parts.some((part, i) => part === '.dork' && parts[i + 1] === 'extensions');
}

/**
 * Note a write a file tool is about to make, when it is aimed inside an extensions folder.
 * Anything else is ignored.
 *
 * @param write - The write, its file already a real path.
 */
export function noteExtensionWrite(write: ExtensionWrite): void {
  if (!isInsideAnExtensionsFolder(write.file)) return;
  writes.push({ ...write, seq: ++lastSeq });
  while (writes.length > WRITE_MEMORY) droppedThrough = writes.shift()!.seq;
}

/**
 * Whether the copy's files changed since this was last asked about it only through its author's
 * own unheld file-tool writes (see the module rules). Starts the copy's next window either way.
 *
 * @param copy - The copy's id and real path.
 * @param authorHome - The real path of the folder its approval names as the author.
 */
export function editedByAuthor(
  copy: { id: string; realPath?: string },
  authorHome: string
): boolean {
  // A first ask in this process reaches back to its start: anything earlier is tied to no one.
  const since = askedAt.get(copy.id) ?? { seq: 0, at: 0 };
  askedAt.set(copy.id, { seq: lastSeq, at: Date.now() });
  if (!copy.realPath) return false;
  if (droppedThrough > since.seq) return false;
  if (runningMarksOf(authorHome).some(marksHold)) return false;
  if (marksEndedSince(authorHome, since.at).some(marksHold)) return false;
  const folder = copy.realPath;
  const author = path.resolve(authorHome);
  const inside = writes.filter((w) => w.seq > since.seq && isInsideFolder(w.file, folder));
  if (inside.length === 0) return false;
  return inside.every(
    (w) => !w.held && w.agentHome !== undefined && path.resolve(w.agentHome) === author
  );
}

/**
 * Forget every write and every window.
 *
 * @internal Exported for testing only — the record outlives one test.
 */
export function resetPathTrustWriters(): void {
  writes.length = 0;
  lastSeq = 0;
  droppedThrough = 0;
  askedAt.clear();
}
