/**
 * Bringing a room's files to the agent, rather than pointing the agent at them
 * (ADR 260807-233816).
 *
 * ## Why a projection and not an absolute path
 *
 * This is the decision, not an implementation note. A room turn runs with
 * a directory the room resolved (`resolve-session-cwd.ts` rung 2 — the agent's
 * own folder, or its working copy of the room's repo), and a room's attachments
 * live under the
 * DorkOS data directory, which is outside either. Reading outside
 * the working directory is precisely what a runtime asks a person's permission
 * for — so handing the model an absolute path would park the turn on
 * `awaiting_approval` and make the word "automatic" false. The alternative,
 * widening the `AgentRuntime` port with a per-turn filesystem grant, needs three
 * different answers for claude-code, codex and opencode and puts a
 * runtime-specific concept into a runtime-neutral port.
 *
 * So the file is brought to the agent, which is the shape chat already ships
 * (ADR-0100): files live inside the working directory and the agent is told a
 * relative path. Nothing in this module imports a runtime SDK, and nothing may:
 * the projection is the same on every runtime, which is the point.
 *
 * ## The invariant this exists to hold
 *
 * **Every path the model is told about is a path it can open.** The plan comes
 * from `buildRoomContext`, built in the same pass that wrote those paths into
 * the context, so this module never decides WHICH files to project — it only
 * puts the planned ones where the plan says they are.
 *
 * ## Failure is not fatal
 *
 * A projection failure must never fail the turn. An agent that gets the words
 * but not one of the files is far better than a room that stops answering, so
 * every error here is logged and swallowed. The agent will find the path
 * missing, which is a thing a model handles; a room that went silent is not.
 *
 * @module server/services/rooms/attachments/attachment-projection
 */
import { copyFile, link, mkdir, readdir, realpath, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { logError, logger } from '../../../lib/logger.js';
import type { ProjectableAttachment } from '../room-context.js';
import { PROJECTED_ATTACHMENTS_ROOT, projectedAttachmentPath } from './attachment-paths.js';
import type { RoomAttachmentStore } from './room-attachment-store.js';

/**
 * How long a projected entry directory survives without being re-projected.
 *
 * Swept on the way IN rather than on a schedule, so the tree stays bounded
 * without this feature introducing a background job. A directory younger than
 * this is left alone even if nothing refers to it any more — the cost of
 * keeping it is a few kilobytes, and the cost of dropping one an in-flight turn
 * is still reading is a file the model was told it could open.
 */
const PROJECTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a filesystem error is the cross-device one that makes a hardlink
 * impossible.
 *
 * The same type-guard shape `services/marketplace/lib/atomic-move.ts` uses for
 * its own `EXDEV` fallback — reused rather than rewritten, because a third
 * spelling of "read the code off an unknown error" is how one of them ends up
 * checking the wrong field. `EPERM` rides along because some filesystems
 * (and Windows volumes) refuse links outright rather than reporting the
 * device difference.
 */
function isUnlinkable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'EXDEV' || code === 'EPERM';
}

/**
 * Put every file this turn's context refers to inside the agent's own working
 * directory, and sweep whatever an earlier turn left behind.
 *
 * **Hardlink first, copy on failure.** The data directory and the default
 * agents directory (`~/.dork/agents`) are normally one filesystem, so a link
 * costs an inode and no bytes however large the file is. A cross-device or
 * permission refusal falls back to a copy, so the observable result is the same
 * either way.
 *
 * **Idempotent**, at one `stat` per file: re-triggering an agent in a busy room
 * re-projects nothing, which matters because a room's window is re-rendered on
 * every single turn.
 *
 * @param input.store - Where the bytes live, resolved LAZILY: the sweep runs
 *   unconditionally and needs no store, so an install with nothing to project
 *   never has to have one wired. `localPath` answering `null` is the honest
 *   signal from a remote store that the bytes must be fetched rather than
 *   linked.
 * @param input.roomId - The room the files were posted in.
 * @param input.cwd - The directory this turn runs in; every destination is
 *   inside it. In a project room that is the agent's working copy of the room's
 *   repo, NOT its home — a file put under the home would be named to the model
 *   by a relative path that does not resolve from where it stands.
 * @param input.attachments - Exactly the files `buildRoomContext` told the model
 *   about. Never widened here.
 * @param input.now - The clock the sweep reads, injectable so a test can age a
 *   directory without fake timers.
 */
export async function projectRoomAttachments(input: {
  store: () => RoomAttachmentStore;
  roomId: string;
  cwd: string;
  attachments: readonly ProjectableAttachment[];
  now?: () => number;
}): Promise<void> {
  // **Nothing planned means nothing done — not one filesystem call.** This runs
  // on the hot path of EVERY room turn, and the overwhelming majority of turns
  // carry no files at all; a `readdir` on each of those would be pure cost, paid
  // by every agent in the product to tidy a directory most of them never have.
  //
  // The trade-off is honest and small: an agent that stops receiving files keeps
  // its last window's projections instead of ageing them out. They are hardlinks
  // in the ordinary case, so they cost inodes rather than bytes; they are bounded
  // by one context window; and the next attachment that agent ever sees sweeps
  // them. Growth is still bounded, which is what the sweep is for.
  if (input.attachments.length === 0) return;

  // **Accepted: giving a room files strands whatever was projected before.** The
  // sweep only ever walks the tree it is called with, so projections an agent
  // received under its own folder before that room had a repo are not aged out
  // by its later turns in the worktree. They are hardlinks bounded by one
  // context window, the agent's own folder is swept again the moment any
  // repo-less room sends it a file, and the alternative — sweeping directories
  // this turn is not standing in — is a deletion path with no idea what else is
  // using them.
  await sweep(input.cwd, input.now ?? Date.now);

  const store = input.store();
  for (const file of input.attachments) {
    try {
      await projectOne(store, input.roomId, input.cwd, file);
    } catch (err) {
      // Logged and swallowed, per this module's contract: one missing file is
      // survivable, a room that stopped answering is not.
      logger.warn('[rooms] could not project a room attachment', {
        roomId: input.roomId,
        entryId: file.entryId,
        attachmentId: file.attachmentId,
        ...logError(err),
      });
    }
  }
}

/** Put one file where the context said it would be. */
async function projectOne(
  store: RoomAttachmentStore,
  roomId: string,
  cwd: string,
  file: ProjectableAttachment
): Promise<void> {
  // The SAME helper that produced the path the model was told, never a second
  // expression of it — that identity is the whole invariant.
  const destination = path.join(
    cwd,
    projectedAttachmentPath(file.entryId, file.attachmentId, file.name)
  );

  // Already there: the common case in a busy room, and the reason this costs a
  // stat rather than a copy per turn.
  if (await exists(destination)) return;

  // **Where the root REALLY is, after symlinks — checked before descending into
  // it.** Every component of this path is server-chosen: the root is a
  // constant, the ids are ULIDs, and the name was sanitized at upload, so
  // nothing an uploader writes can steer it. What an uploader cannot control
  // but an AGENT can is the tree being written into — plant
  // `.dork/.temp/room-attachments` as a symlink to somewhere else and this
  // would write room attachments outside the agent's own working directory,
  // through a path that looks contained at every layer above.
  //
  // The root is created and resolved FIRST so a redirected root is refused
  // before anything is made inside whatever it points at. The sweep inherits
  // the same protection: it only ever walks this root.
  const root = path.join(cwd, PROJECTED_ATTACHMENTS_ROOT);
  await mkdir(root, { recursive: true });
  await assertInside(cwd, root);

  await mkdir(path.dirname(destination), { recursive: true });

  const source = await store.localPath(roomId, file.attachmentId, file.extension);
  if (source === null) {
    // The bytes are not on this machine — a remote store. Fetch them through the
    // store's own reader rather than the URL, so this module still knows nothing
    // about where the bytes actually live.
    const stored = await store.get(
      roomId,
      file.attachmentId,
      file.extension,
      'application/octet-stream'
    );
    if (!stored) throw new Error('the store has no bytes for a planned attachment');
    await writeFile(destination, await drain(stored.stream));
    return;
  }

  try {
    await link(source, destination);
  } catch (err) {
    if (!isUnlinkable(err)) throw err;
    await copyFile(source, destination);
  }
}

/**
 * Refuse a destination whose REAL location is outside the agent's tree.
 *
 * `realpath` on both sides, so a symlink anywhere along either one is followed
 * before the comparison; the separator on the prefix stops `/agents/ana-evil`
 * from passing as inside `/agents/ana`.
 */
async function assertInside(cwd: string, directory: string): Promise<void> {
  const [root, real] = await Promise.all([realpath(cwd), realpath(directory)]);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`a projected attachment would land outside the turn's directory: ${real}`);
  }
}

/** Read a stream to the end. */
async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Whether a path is already there. */
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Drop projected entry directories older than {@link PROJECTION_TTL_MS}.
 *
 * Keyed on the directory's own mtime, which a re-projection refreshes by
 * writing into it — so a conversation still being read stays, and one nobody
 * has mentioned in a day goes. Failures are swallowed for the same reason
 * projection failures are: a sweep that could not run must not stop a turn.
 */
async function sweep(cwd: string, now: () => number): Promise<void> {
  const root = path.join(cwd, PROJECTED_ATTACHMENTS_ROOT);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No projections yet, which is the normal state for most agents.
    return;
  }

  const cutoff = now() - PROJECTION_TTL_MS;
  for (const name of entries) {
    const directory = path.join(root, name);
    try {
      const stats = await stat(directory);
      if (stats.mtimeMs >= cutoff) continue;
      await rm(directory, { recursive: true, force: true });
    } catch (err) {
      logger.warn('[rooms] could not sweep a projected attachment directory', {
        directory,
        ...logError(err),
      });
    }
  }
}
