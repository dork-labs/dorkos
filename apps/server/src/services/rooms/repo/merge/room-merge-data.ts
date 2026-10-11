/** Pure Room merge refusal, announcement and lexical target DATA. */
import path from 'node:path';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type { RoomRepoStore } from '../room-repo-store.js';
import type { RoomRepoMutex } from '../room-repo-mutex.js';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';

/**
 * The sentence the room posts about a merge.
 *
 * Its own function so the copy is one string that tests can pin, and so the
 * summary is interpolated in exactly one place.
 *
 * @param agentName - Whose work landed.
 * @param summary - Their own sanitized summary.
 * @param stat - What the merge touched.
 */
export function mergeSentence(
  agentName: string,
  summary: string,
  stat: { files: number; insertions: number; deletions: number }
): string {
  const who = sanitizeIdentity(agentName) ?? 'An agent';
  return `${who} merged: ${summary} — ${plural(stat.files, 'file')}, +${stat.insertions}/−${stat.deletions}`;
}

/**
 * `1 commit` / `3 commits` — the small grammar the refusals need.
 *
 * @param count - How many.
 * @param noun - The singular noun.
 */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A byte count as a person reads it.
 *
 * Deliberately coarse: the refusal is about "too big", and `5 MB` says that
 * where `5,242,880 bytes` makes a reader do arithmetic.
 *
 * @param bytes - The count.
 */
export function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Spellings of `.git` that a case-insensitive or 8.3-aware filesystem opens as
 * the real thing.
 *
 * `.git` is compared **lower-cased**, which is the whole of the first two
 * entries: APFS and NTFS are case-insensitive by default, so `.GIT/config` and
 * `.Git/hooks/pre-commit` open exactly the file `.git/config` opens. A
 * case-blind comparison here let both through end to end — into `repo/`, the
 * server-owned checkout where `.git` is a real directory and `.git/config` is
 * the COMMON directory shared by every worktree of the room.
 *
 * The last two are NTFS's other doors to the same place: a trailing dot is
 * stripped by the Win32 path layer, and `git~1` is the short (8.3) alias
 * Windows generates for `.git`. Both are refused for the same reason git itself
 * refuses them in `.gitmodules` paths — the name that reaches the filesystem is
 * not the name in the tree.
 */
const GIT_DIR_SPELLINGS: readonly string[] = ['.git', '.git.', 'git~1'];

/**
 * Whether a symlink stored at `entryPath` points anywhere but inside the room's
 * own files.
 *
 * **Purely lexical, and it has to be.** Resolving against the real filesystem
 * would ask where the link points on THIS machine right now — but the tree is
 * about to be shared with every other checkout of this repo, and a link that
 * lands inside the repo here can land outside it there. The question is about
 * the path, so the path is what is answered.
 *
 * Five ways out, and all five are refused: an absolute POSIX path, a
 * Windows-style drive path, a UNC share, a relative path that climbs past the
 * root, and a path into the repository's own git directory — which is not one
 * of the room's files and is the one place a link could reach git's own
 * configuration and its hooks.
 *
 * **Separators are normalized BEFORE any of the five run, and the order is a
 * fix rather than a tidy-up.** The absolute test used to read the RAW target,
 * so a Windows-absolute `\etc\passwd` and a UNC `\\server\share\x` both failed
 * `startsWith('/')`, and only THEN were their backslashes turned into slashes —
 * by which point nothing was left to catch them. One normalization, then five
 * questions, all asked of the same string.
 *
 * @param entryPath - Where the link lives, relative to the repo root.
 * @param target - What it points at, as stored in the blob.
 * @returns `true` when the link leaves the room's files.
 */
export function symlinkLeavesRepo(entryPath: string, target: string): boolean {
  // FIRST, so every test below sees one separator. A UNC path (`\\server\x`)
  // becomes `//server/x` and is caught by the absolute test, which is exactly
  // what it is.
  const normalized = target.replaceAll('\\', '/');
  if (normalized.startsWith('/')) return true;
  if (/^[A-Za-z]:\//.test(normalized)) return true;

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), normalized));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return true;

  // Lower-cased: on APFS and NTFS, `.GIT/config` opens `.git/config`.
  const lowered = resolved.toLowerCase();
  return GIT_DIR_SPELLINGS.some(
    (spelling) => lowered === spelling || lowered.startsWith(`${spelling}/`)
  );
}

/** Compare the complete original resolved merge-target DATA. */
export function sameMergeTarget(
  left: { slug: string; branch: string; authorId: string; agentName: string },
  right: { slug: string; branch: string; authorId: string; agentName: string }
): boolean {
  return (
    left.slug === right.slug &&
    left.branch === right.branch &&
    left.authorId === right.authorId &&
    left.agentName === right.agentName
  );
}

/** The seams {@link RoomMergeService} needs from the rest of the server. */
export interface RoomMergeServiceDeps {
  /** Owns every path under a room's home; never construct one by hand. */
  store: RoomRepoStore;
  /** The per-room serialized queue every write to `repo/` goes through. */
  mutex: RoomRepoMutex;
  /** `config.rooms.repo.enabled`, read per call. */
  enabled(): boolean;
  /** `config.rooms.repo.mergeQueueWaitMs`, read per call. */
  mergeQueueWaitMs(): number;
  /**
   * Refuse a caller who is not on this room's roster, and answer with the room.
   *
   * `RoomService.requireMembership` in production. Membership is the gate on
   * both verbs, exactly as it is on the history reads, and "not a member"
   * answers as "no such room" so a room id is never a capability.
   */
  requireMembership(roomId: string, authorId: string): Room;
  /**
   * The agent members of a room, with the workspace path each is keyed by.
   *
   * `RoomService.listAgentMembers` in production. The paths never leave this
   * module — what a caller sees is the slug derived from one.
   */
  listAgentMembers(roomId: string): { authorId: string; agentPath: string; displayName: string }[];
  /** Which working copies hold work `main` has not got. */
  listStrandedWorktrees(roomId: string): Promise<string[]>;
  /**
   * Announce a merge in the room. `RoomService.postMergeEvent` in production —
   * the single write path into a room's log, never a second one.
   */
  announce(
    roomId: string,
    input: {
      text: string;
      merge: {
        branch: string;
        commit: string;
        files: number;
        insertions: number;
        deletions: number;
      };
      subjectAuthorId: string;
    }
  ): RoomEntry;
  /** Whether an author is the person who owns this install. */
  isOwnerAuthor(authorId: string): boolean;
}
