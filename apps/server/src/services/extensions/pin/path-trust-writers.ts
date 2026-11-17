/**
 * Who wrote a path-trust copy's files (DOR-4528).
 *
 * Path trust (`extension-path-trust.ts`) lets an edit to an agent's own mini app run without a
 * card while that agent is at Full (`path-trust-edits.ts`). The level says what the agent may do;
 * it does not say which of its turns wrote the files. A turn that holds a mark (`marksHold`, a
 * stranger's words) or runs under a ceiling may not get a standing yes for new code, so an edit is
 * trusted only when every changed byte can be traced to the author's own turn that held neither.
 *
 * ## The record
 *
 * The runtime's file-tool hooks note each write aimed inside a `.dork/extensions/` folder: before
 * it runs, the file's real path, its content hash, the content the tool was asked to leave, the
 * turn's agent and whether the turn was held ({@link noteWriteStarting}); after it succeeds, the
 * file's content hash again ({@link noteWriteDone}). A file that does not then hold exactly what
 * the tool was asked to leave was touched by something else as well, so that write vouches for
 * nothing. A write that is refused or fails is never completed, so it is not kept. The record is
 * in memory only: an edit made before a restart is tied to no one.
 *
 * ## The verdict
 *
 * {@link tiedToAuthor} compares the files last trusted with the files about to be trusted, both
 * by content, file by file. The change is the author's only when ALL of these hold:
 *
 * - every changed file has completed writes since the files were last trusted, each by the
 *   author's own unheld turn, that chain from the trusted content to the new content exactly
 *   (each write starts from what the one before it left), so a byte written by anything the hooks
 *   did not see breaks the chain;
 * - no file was removed, and no link or special file changed;
 * - no turn of the author that held a mark ran since the files were last trusted, by any tool
 *   and on any runtime (`live-outsider-turns.ts` counts every runtime's marked turns);
 * - the record did not overflow in that time.
 *
 * Anything else, including a write by the shell, by another runtime with no file-tool hook, or by
 * a program outside DorkOS, waits for a person. Fails closed.
 *
 * @module services/extensions/pin/path-trust-writers
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { marksEndedSince, runningMarksOf } from '../../core/turn-power/live-outsider-turns.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import { fileSha256Hex } from '../../marketplace/lib/records/tree-scan.js';
import { isInsideFolder } from './extension-path-trust.js';

/** One file's content as the record keeps it: `sha256:<hex>`, or `absent` for no file. */
export type FileContent = string;

/**
 * The bytes a write was asked to leave, worked out from the file's bytes before it (`null` when
 * there was no file), or `null` when they cannot be worked out.
 */
export type ExpectedAfter = (before: Buffer | null) => Buffer | null;

/** The largest file whose bytes are read to check a write; a larger one vouches for nothing. */
const MAX_CHECKED_BYTES = 5 * 1024 * 1024;

/** What a content that never matches anything is called. */
const UNMATCHED: FileContent = 'unreadable';

/** A write a file-tool hook saw start, aimed inside an extensions folder. */
export interface ExtensionWriteStart {
  /** The file's real path, symlinks resolved as far as the file exists. */
  file: string;
  /** The real path of the turn's agent home, or undefined when the turn runs as no agent. */
  agentHome: string | undefined;
  /** Whether the turn held a mark or ran under a ceiling when it wrote. */
  held: boolean;
}

/** A completed write: where it started from and what it left. */
interface CompletedWrite extends ExtensionWriteStart {
  before: FileContent;
  after: FileContent;
  seq: number;
}

/** How many completed writes are kept, oldest dropped first. */
const WRITE_MEMORY = 5_000;

/** How many writes may wait for their result at once, oldest dropped first. */
const PENDING_MEMORY = 1_000;

/** Tool call id → a write that has started and not finished, with what it should leave. */
const pending = new Map<
  string,
  ExtensionWriteStart & { before: FileContent; expected: FileContent }
>();

/** The completed writes, oldest first. */
const writes: CompletedWrite[] = [];

/** The place of the last completed write. A counter, not the clock: one write is in one window. */
let lastSeq = 0;

/** The place of the newest write dropped for room; a window reaching back that far is unknown. */
let droppedThrough = 0;

/** Copy id → when its files were last trusted: the last write then, and the time. */
const trustedAt = new Map<string, { seq: number; at: number }>();

/** Whether a path names something inside some `.dork/extensions/` folder. */
export function isInsideAnExtensionsFolder(file: string): boolean {
  const parts = path.resolve(file).split(path.sep);
  return parts.some((part, i) => part === '.dork' && parts[i + 1] === 'extensions');
}

/**
 * A file's content now, as the record keeps it. A file that is not there is `absent`; one that
 * cannot be read is `unreadable`, which never matches anything, so it can only make an edit wait.
 *
 * @param file - The file's path.
 */
export async function contentOf(file: string): Promise<FileContent> {
  try {
    return `sha256:${await fileSha256Hex(file)}`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : UNMATCHED;
  }
}

/** The content of some bytes, as the record keeps it. */
function contentOfBytes(bytes: Buffer): FileContent {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A file's bytes, `null` when there is none, `undefined` when they cannot be read or are too big. */
async function bytesOf(file: string): Promise<Buffer | null | undefined> {
  try {
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.size > MAX_CHECKED_BYTES) return undefined;
    return await fs.readFile(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/**
 * Note a write a file tool is about to make: the file's content before it, and the content it
 * was asked to leave. Ignored unless it is aimed inside an extensions folder.
 *
 * @param callId - The tool call's id, which its result carries.
 * @param write - The write, its file already a real path.
 * @param expect - Works out the bytes the write should leave from the bytes before it.
 */
export async function noteWriteStarting(
  callId: string,
  write: ExtensionWriteStart,
  expect: ExpectedAfter
): Promise<void> {
  if (!isInsideAnExtensionsFolder(write.file)) return;
  const bytes = await bytesOf(write.file);
  let before = UNMATCHED;
  let expected = UNMATCHED;
  if (bytes !== undefined) {
    before = bytes === null ? 'absent' : contentOfBytes(bytes);
    try {
      const after = expect(bytes);
      if (after) expected = contentOfBytes(after);
    } catch {
      // Cannot be worked out: the write vouches for nothing.
    }
  }
  pending.delete(callId);
  pending.set(callId, { ...write, before, expected });
  while (pending.size > PENDING_MEMORY) pending.delete(pending.keys().next().value!);
}

/**
 * Note that a write noted by {@link noteWriteStarting} succeeded, with the content it left.
 *
 * @param callId - The tool call's id.
 */
export async function noteWriteDone(callId: string): Promise<void> {
  const started = pending.get(callId);
  if (!started) return;
  pending.delete(callId);
  const { expected, ...write } = started;
  const now = await contentOf(started.file);
  // Anything but exactly what the tool was asked to leave means another hand was in it too.
  const after = expected !== UNMATCHED && now === expected ? now : UNMATCHED;
  writes.push({ ...write, after, seq: ++lastSeq });
  while (writes.length > WRITE_MEMORY) droppedThrough = writes.shift()!.seq;
}

/**
 * Forget a write that started and did not succeed.
 *
 * @param callId - The tool call's id.
 */
export function noteWriteFailed(callId: string): void {
  pending.delete(callId);
}

/**
 * Record that a copy's files are trusted as of now, so the next verdict only reads what came
 * after.
 *
 * @param id - The copy's id.
 */
export function markTrusted(id: string): void {
  trustedAt.set(id, { seq: lastSeq, at: Date.now() });
}

/** What {@link tiedToAuthor} compares. */
export interface AuthorCheck {
  /** The copy's id. */
  id: string;
  /** The copy's real folder, which its files' paths are relative to. */
  folder: string;
  /** The real path of the folder its approval names as the author. */
  authorHome: string;
  /** The files last trusted, by relative path. */
  trusted: Readonly<Record<string, FileContent>>;
  /** The files about to be trusted, by relative path. */
  next: Readonly<Record<string, FileContent>>;
}

/** Whether one changed file's writes chain from `from` to `to`, all by the author, none held. */
function chainHolds(
  file: string,
  from: FileContent,
  to: FileContent,
  author: string,
  since: number
) {
  let at = from;
  let seen = false;
  for (const w of writes) {
    if (w.seq <= since || w.file !== file) continue;
    seen = true;
    if (w.held || w.agentHome === undefined || path.resolve(w.agentHome) !== author) return false;
    if (w.before === UNMATCHED || w.before !== at) return false;
    at = w.after;
  }
  return seen && at !== UNMATCHED && at === to;
}

/**
 * Whether the change from the trusted files to the next ones is all the author's own unheld work
 * (see the module rules).
 *
 * @param check - The copy, its author and the two sets of files.
 */
export function tiedToAuthor(check: AuthorCheck): boolean {
  // A first check in this process reaches back to its start: anything earlier is tied to no one.
  const since = trustedAt.get(check.id) ?? { seq: 0, at: 0 };
  if (droppedThrough > since.seq) return false;
  const author = path.resolve(check.authorHome);
  if (runningMarksOf(author).some(marksHold)) return false;
  if (marksEndedSince(author, since.at).some(marksHold)) return false;
  for (const rel of new Set([...Object.keys(check.trusted), ...Object.keys(check.next)])) {
    const from = check.trusted[rel] ?? 'absent';
    const to = check.next[rel];
    if (from === to) continue;
    // Removed, or a link or special file: no file tool makes those.
    if (to === undefined || !to.startsWith('sha256:')) return false;
    if (from !== 'absent' && !from.startsWith('sha256:')) return false;
    const file = path.join(check.folder, ...rel.split('/'));
    if (!isInsideFolder(file, check.folder)) return false;
    if (!chainHolds(file, from, to, author, since.seq)) return false;
  }
  return true;
}

/**
 * Forget every write and every window.
 *
 * @internal Exported for testing only — the record outlives one test.
 */
export function resetPathTrustWriters(): void {
  pending.clear();
  writes.length = 0;
  lastSeq = 0;
  droppedThrough = 0;
  trustedAt.clear();
}
