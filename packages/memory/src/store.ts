/**
 * The memory file store: reads that are honest about what they found, writes
 * that are capped, serialised and atomic.
 *
 * @module memory/store
 */
import { readFile } from 'node:fs/promises';

import { withFileLock } from '@dorkos/shared/atomic-write';
import { MEMORY_OVERSIZE_WARNING } from '@dorkos/shared/convention-files';
import {
  AgentMemoryRefSchema,
  MemoryCapExceededError,
  MemoryIOError,
  MemorySelectorSchema,
  MemorySnapshotSchema,
  MemoryWriteOpSchema,
  type AgentMemoryRef,
  type MemorySelector,
  type MemorySnapshot,
  type MemoryWriteOp,
  type MemoryWriteResult,
} from '@dorkos/shared/memory-provider';

import { MEMORY_MAX_CHARS } from './constants.js';
import { applyMemoryOp } from './ops.js';
import { resolveMemoryFile } from './paths.js';
import { defaultMemoryTemplate } from './scaffold.js';

/**
 * The one line a reader sees when a memory file is bigger than the cap.
 *
 * **Re-exported, not declared.** It is owned by
 * `@dorkos/shared/convention-files` because the cockpit's Injection Preview
 * renders the same warning and cannot import this package — see that constant
 * for why a per-surface wording is the failure mode.
 */
export { MEMORY_OVERSIZE_WARNING } from '@dorkos/shared/convention-files';

/**
 * Read one agent's memory, reporting which of three things is true: it is
 * there, it is confirmed not there, or it could not be read.
 *
 * **This never throws for a missing or unreadable file.** Both are reported on
 * the result, because this read happens on the way into a turn and a memory
 * problem must never be able to stop a conversation. The difference between the
 * last two states is the whole point: an unreadable file reported as an empty
 * one invites an agent to write a fresh note over the top of everything it could
 * not see.
 *
 * A file larger than the cap comes back truncated to exactly
 * {@link MEMORY_MAX_CHARS} characters with {@link MEMORY_OVERSIZE_WARNING}
 * attached — loudly, never silently.
 *
 * @param ref - Whose memory to read.
 */
export async function readMemorySnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot> {
  let file: string;
  try {
    file = resolveMemoryFile(AgentMemoryRefSchema.parse(ref).agentPath);
  } catch (err) {
    // A path this engine refuses to resolve is a caller bug, not an I/O
    // condition — but it reaches the same reader, so it takes the same shape
    // rather than throwing into an injection path that has nothing to do.
    return errorSnapshot(err);
  }

  try {
    const raw = await readRawMemory(file);
    // A file that does not exist and a file emptied down to whitespace are the
    // same situation for a reader: there is nothing to show. Reporting the
    // second as `present` would put a fence around a blank line and announce it
    // as this agent's memory — which is what an agent that has just forgotten
    // its last note would see, and it is worse than seeing nothing.
    if (raw === null || raw.trim() === '') {
      return MemorySnapshotSchema.parse({
        status: 'absent',
        content: '',
        bytes: 0,
        truncated: false,
      });
    }

    const truncated = raw.length > MEMORY_MAX_CHARS;
    return MemorySnapshotSchema.parse({
      status: 'present',
      content: truncated ? trimDanglingSurrogate(raw.slice(0, MEMORY_MAX_CHARS)) : raw,
      // The size of the FILE, which is what makes the truncation legible: the
      // reader can see that what it was handed is smaller than what exists.
      bytes: Buffer.byteLength(raw, 'utf8'),
      truncated,
      ...(truncated ? { warning: MEMORY_OVERSIZE_WARNING } : {}),
    });
  } catch (err) {
    return errorSnapshot(err);
  }
}

/**
 * Drop a high surrogate left stranded at the end of a slice.
 *
 * The cap counts UTF-16 code units, so slicing at exactly the cap can land
 * between the two halves of an astral character — an emoji, or most of the text
 * in several writing systems. The orphan half is not a character: it renders as
 * U+FFFD at best, and travels as an unpaired surrogate through JSON and into a
 * prompt at worst. One code unit is the whole cost of never emitting one.
 *
 * @param text - The slice, possibly ending mid-pair.
 */
function trimDanglingSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/**
 * Apply one change to an agent's memory.
 *
 * Three properties hold together, and each covers what the others cannot:
 *
 * - **Serialised per agent.** The whole read-modify-write runs inside
 *   `withFileLock` on the resolved path, and that path IS the agent's identity —
 *   one file, one lock. Without it, two sessions of the same agent that each
 *   save a note in the same moment both read the old file and the second write
 *   erases the first, silently. That is the exact lost update the plain
 *   `fs.writeFile` in the convention-file writer would allow.
 * - **Atomic.** The write goes out through a unique temp file and a rename, so a
 *   reader mid-write sees the previous file, never half of this one.
 * - **All-or-nothing.** The cap and the unique-match rule are checked before
 *   anything is written, so a refused write leaves memory exactly as it was.
 *
 * **What the lock covers, and what it does not — corrected.** An earlier
 * revision of this comment claimed "both writers write whole files atomically",
 * and that was false in the direction that mattered: the in-app editor wrote
 * through `writeConventionFile`, which was a bare `fs.writeFile` with no lock
 * and no rename. `O_TRUNC` left a window in which the file was zero bytes, and a
 * read landing inside it saw an empty memory and committed the truncation as a
 * successful save — measured at ~1% of interleaves here and ~3.5% on the
 * reviewer's machine, silently, reporting `{ saved: true }`. That writer now
 * takes THIS lock, on the same path, so the two are strictly serialised and the
 * claim is true because it was made true.
 *
 * What remains uncovered is genuinely uncovered: the lock lives in this
 * process's memory, so a person editing the file in a real text editor is a
 * second writer nothing here can serialise against. That race is accepted — the
 * file is small, human edits are deliberate and rare, and both sides now publish
 * through a rename, so the outcome is last-writer-wins and never a torn file.
 * What an operator can lose is one note saved during the seconds their editor
 * held a stale copy.
 *
 * An agent whose memory file does not exist yet gets one here, starting from the
 * scaffold — this is how every agent created before this feature acquires the
 * file.
 *
 * @param ref - Whose memory to change.
 * @param op - The change.
 * @throws {MemoryCapExceededError} When the result would exceed the cap.
 * @throws {MemoryMatchError} When a `replace` or `remove` names no single
 *   editable place — including one inside the file's protected header.
 * @throws {MemoryIOError} When the file itself could not be read or written.
 * @throws {MemoryPathError} When the ref's `agentPath` could reach outside the
 *   agent's own directory.
 */
export async function writeMemory(
  ref: AgentMemoryRef,
  op: MemoryWriteOp
): Promise<MemoryWriteResult> {
  const parsedRef = AgentMemoryRefSchema.parse(ref);
  const parsedOp = MemoryWriteOpSchema.parse(op);
  const file = resolveMemoryFile(parsedRef.agentPath);

  return withFileLock(file, async (write) => {
    let existing: string | null;
    try {
      existing = await readRawMemory(file);
    } catch (err) {
      throw new MemoryIOError('read', err);
    }
    const created = existing === null;
    const before = existing ?? defaultMemoryTemplate();
    const after = applyMemoryOp(before, parsedOp);

    // Strictly greater: a write that lands exactly ON the cap is allowed, so the
    // limit is a limit rather than one character less than one. A file already
    // over the cap — only reachable by editing it on disk — can still be edited
    // as long as the edit does not make it BIGGER, which is what keeps the fix
    // available from inside. (Equal length passes too: a correction that swaps
    // one note for another of the same size is not what the cap is defending
    // against.)
    if (after.length > MEMORY_MAX_CHARS && after.length > before.length) {
      throw new MemoryCapExceededError(before.length, after.length, MEMORY_MAX_CHARS);
    }

    try {
      await write(after);
    } catch (err) {
      // Everything above this line is a refusal the caller could act on. This is
      // not one: a full disk or an unwritable directory has nothing to do with
      // what was asked for, and a raw `ENOSPC` reaching a tool result would put
      // the operating system's own sentence in front of a model mid-turn.
      throw new MemoryIOError('write', err);
    }

    return {
      created,
      chars: after.length,
      bytes: Buffer.byteLength(after, 'utf8'),
    };
  });
}

/**
 * Forget one note, located the same way `remove` locates one.
 *
 * @param ref - Whose memory to change.
 * @param selector - Text that must appear exactly once.
 * @throws {MemoryMatchError} When it appears twice or not at all.
 */
export async function forgetMemory(ref: AgentMemoryRef, selector: MemorySelector): Promise<void> {
  const { text } = MemorySelectorSchema.parse(selector);
  await writeMemory(ref, { action: 'remove', oldText: text });
}

/**
 * Read the file, distinguishing "not there" from "could not read it".
 *
 * @param file - The resolved memory path.
 * @returns The contents, or `null` when the file does not exist.
 */
async function readRawMemory(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Shape a failed read as a snapshot the injection path can render as nothing. */
function errorSnapshot(err: unknown): MemorySnapshot {
  return MemorySnapshotSchema.parse({
    status: 'error',
    content: '',
    bytes: 0,
    truncated: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
