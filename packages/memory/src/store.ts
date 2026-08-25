/**
 * The memory file store: reads that are honest about what they found, writes
 * that are capped, serialised and atomic.
 *
 * @module memory/store
 */
import { readFile } from 'node:fs/promises';

import { withFileLock } from '@dorkos/shared/atomic-write';
import {
  AgentMemoryRefSchema,
  MemoryCapExceededError,
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
 * Exported because whoever renders the snapshot has to render this too, and a
 * warning that each surface words for itself is a warning one surface forgets.
 * A file can only get this big by being edited on disk — the tool and the wire
 * both refuse to cross the cap — so the honest thing is to show what fits and
 * say plainly that there is more.
 */
export const MEMORY_OVERSIZE_WARNING =
  `Only the first ${MEMORY_MAX_CHARS} characters of this file are shown here — it is longer ` +
  `than that. Tidy it up so nothing important is left out.`;

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
    if (raw === null) {
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
      content: truncated ? raw.slice(0, MEMORY_MAX_CHARS) : raw,
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
 * An agent whose memory file does not exist yet gets one here, starting from the
 * scaffold — this is how every agent created before this feature acquires the
 * file.
 *
 * @param ref - Whose memory to change.
 * @param op - The change.
 * @throws {MemoryCapExceededError} When the result would exceed the cap.
 * @throws {MemoryMatchError} When a `replace` or `remove` names no single place.
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
    const existing = await readRawMemory(file);
    const created = existing === null;
    const before = existing ?? defaultMemoryTemplate();
    const after = applyMemoryOp(before, parsedOp);

    // Strictly greater: a write that lands exactly ON the cap is allowed, so the
    // limit is a limit rather than one character less than one. A file already
    // over the cap — only reachable by editing it on disk — can still be made
    // smaller, which is what keeps the fix available from inside.
    if (after.length > MEMORY_MAX_CHARS && after.length > before.length) {
      throw new MemoryCapExceededError(before.length, after.length, MEMORY_MAX_CHARS);
    }

    await write(after);

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
