/**
 * Where a caller may start or feed a chat, asked the same way by every surface
 * that lets a caller choose (DOR-3644): the in-session `session_start` tool and
 * `POST /api/sessions/:id/messages`, plus the fork route's folder.
 *
 * A turn's identity is anchored to the folder it stands in
 * (`launch-resolver.ts`), so whoever picks the folder picks who the turn runs
 * as: its permission level, memory, connections, room seat and audit trail. A
 * person may pick any folder. An agent may pick its own home, a managed
 * workspace or worktree of it, or a folder no agent owns, and never another
 * agent's chat. A caller DorkOS cannot name as an agent may pick no agent's
 * folder or chat at all, since it could be any of them.
 *
 * One rule, in one place, so the tool and the route cannot drift apart again
 * (`session_start` refused this from DOR-790; the route never asked).
 *
 * @module services/session/launch/launch-caller
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import { resolveAgentHome } from '../../core/agent-identity/index.js';
import { isProtectedPath } from '../../runtimes/shared/policy/protected-path-check.js';
import { protectedPathRoots } from '../../runtimes/shared/policy/protected-path-roots.js';

/**
 * Who chose where a chat runs. `person`: the person, at the app. `agent`: an
 * agent DorkOS verified, by its home. `unidentified`: anything else that is
 * not the person (a program with no token, a revoked or expired token).
 *
 * Absent on a launch the server places itself (a schedule, a beat, a room
 * turn, a carry-over), where no caller chose the folder.
 */
export type SessionLauncher =
  | { readonly kind: 'person' }
  | { readonly kind: 'agent'; readonly agentPath: string }
  | { readonly kind: 'unidentified' };

/** Why {@link launchPlaceRefusal} refused, kept apart so `session_start` can keep its codes. */
export type LaunchPlaceRefusalCode =
  | 'NOT_THE_CALLER'
  | 'OTHER_AGENTS_FOLDER'
  | 'OTHER_AGENTS_CHAT'
  | 'UNIDENTIFIED_LAUNCHER'
  | 'PROTECTED_FOLDER';

/** A refused place, with the sentence the caller shows as-is. */
export interface LaunchPlaceRefusal {
  /** Which rule refused it. */
  code: LaunchPlaceRefusalCode;
  /** The sentence. */
  message: string;
}

/** The refusal for a session that would run as some other agent. */
export const NOT_THE_CALLER_MESSAGE =
  'An agent can start a session only as itself. Leave out agentPath, or give your own folder.';

/** The refusal for a folder that belongs to another agent. */
export const OTHER_AGENTS_HOME_MESSAGE =
  "That folder belongs to another agent. Start the session in a folder that is not another agent's.";

/** The refusal for a message into a chat another agent runs. */
const OTHER_AGENTS_CHAT_MESSAGE =
  'That chat belongs to another agent. To reach it, send it a message with chat_send instead.';

/** The refusal for a caller DorkOS cannot name, asking for an agent's folder or chat. */
const UNIDENTIFIED_LAUNCHER_MESSAGE =
  "DorkOS can't tell which agent is asking, so it can't start work in an agent's folder or chat.";

/** The refusal for a new chat in DorkOS's data folder, the home folder, or above either. */
export const PROTECTED_FOLDER_MESSAGE =
  "That folder holds DorkOS's private files, so no agent can start a chat there. Use your own folder.";

/** The same refusal when the caller named no folder and the default is one of them. */
export const PROTECTED_DEFAULT_FOLDER_MESSAGE =
  'No folder was named, and the default holds private files. Name a folder with `cwd`.';

/** Where the launch would run, as far as the caller named it. */
export interface LaunchPlace {
  /** The folder the turn would stand in. */
  cwd?: string;
  /** The agent the request names as the chat's owner. */
  agentPath?: string;
  /** The agent an existing chat already runs as. */
  chatAgent?: string | null;
  /** True when the caller named no folder and `cwd` is the server's default. */
  defaulted?: boolean;
}

/** Whether `dir` is `root` or inside it. */
function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A folder's real path, or its resolved spelling when it cannot be read (a
 * folder that does not exist yet). Both sides of a containment check go through
 * this, because the boundary check hands back `cwd` real-pathed while Mesh keeps
 * each home as registered: a home under a symlink (macOS's `/tmp`) would
 * otherwise never contain a `cwd` that is inside it.
 */
function realOr(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** The innermost registered home `cwd` sits in, real-pathed, if any. */
function owningHome(meshCore: Pick<MeshCore, 'listWithPaths'> | undefined, cwd: string) {
  const target = realOr(cwd);
  return (
    (meshCore?.listWithPaths() ?? [])
      .map((agent) => realOr(agent.projectPath))
      .filter((home) => isWithin(home, target))
      // The innermost home is the folder's owner: an agent may keep another's
      // home inside its own, and the one closer to `cwd` is the one standing there.
      .sort((a, b) => b.length - a.length)[0]
  );
}

/**
 * Whether `cwd` belongs to an agent other than `callerPath`: it resolves to
 * another agent's home (its home, a managed workspace or a linked worktree of
 * it), or it sits inside a registered agent's home that is not the caller's.
 *
 * @param meshCore - Mesh, which lists the registered homes.
 * @param cwd - The folder the session would work in.
 * @param callerPath - The calling agent's own home.
 */
function isOtherAgentsFolder(
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  cwd: string,
  callerPath: string
): boolean {
  if (resolveAgentHome(cwd, callerPath).kind === 'refused') return true;
  const owner = owningHome(meshCore, cwd);
  return owner !== undefined && owner !== realOr(callerPath);
}

/**
 * Whether `cwd` belongs to any agent at all: it resolves to a home, or sits
 * inside a registered one.
 *
 * @param meshCore - Mesh, which lists the registered homes.
 * @param cwd - The folder the session would work in.
 */
function isAnyAgentsFolder(
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  cwd: string
): boolean {
  return resolveAgentHome(cwd).kind !== 'none' || owningHome(meshCore, cwd) !== undefined;
}

/**
 * Whether a caller other than the person may not start a NEW chat in `cwd`
 * (DOR-4060), since every file tool trusts a chat's own folder:
 *
 * - a folder on the protected-files list, always;
 * - DorkOS's data folder, or anything inside it but an agent's home or a
 *   managed workspace;
 * - the home folder, or any folder above it or the data folder, unless it is
 *   the caller's own folder or inside it (a dev data folder sits in its repo).
 *
 * Every spelling is real-pathed, so a symlink to one of them is that folder.
 *
 * @param cwd - The folder the new chat would stand in.
 * @param ownFolder - The calling agent's own home, when DorkOS knows it.
 */
export function isProtectedLaunchFolder(cwd: string, ownFolder?: string): boolean {
  const target = realOr(cwd);
  try {
    const roots = protectedPathRoots(target);
    if (isProtectedPath(target, 'read', roots)) return true;
    const data = realOr(roots.data);
    if (isWithin(data, target)) {
      return !['agents', 'workspaces'].some(
        (place) => isWithin(path.join(data, place), target) && target !== path.join(data, place)
      );
    }
    if (!isWithin(target, data) && !isWithin(target, realOr(roots.home))) return false;
    return ownFolder === undefined || !isWithin(realOr(ownFolder), target);
  } catch {
    // A folder that cannot be checked is not a folder to start in.
    return true;
  }
}

/**
 * Why this caller may not run a chat at this place, or `null` when it may.
 * A person is never refused here. The protected-folder rule asks only of a new
 * chat (no `chatAgent`), so a message into a chat that already stands in such a
 * folder, like a schedule's, still reaches it.
 *
 * @param meshCore - Mesh, which lists the registered homes.
 * @param launcher - Who chose the place.
 * @param place - The folder, the named owner and an existing chat's agent.
 */
export function launchPlaceRefusal(
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  launcher: SessionLauncher,
  place: LaunchPlace
): LaunchPlaceRefusal | null {
  if (launcher.kind === 'person') return null;
  const ownFolder = launcher.kind === 'agent' ? launcher.agentPath : undefined;
  if (
    place.cwd !== undefined &&
    place.chatAgent === undefined &&
    isProtectedLaunchFolder(place.cwd, ownFolder)
  ) {
    return {
      code: 'PROTECTED_FOLDER',
      message: place.defaulted ? PROTECTED_DEFAULT_FOLDER_MESSAGE : PROTECTED_FOLDER_MESSAGE,
    };
  }
  if (launcher.kind === 'unidentified') {
    const agents =
      place.agentPath !== undefined ||
      !!place.chatAgent ||
      (place.cwd !== undefined && isAnyAgentsFolder(meshCore, place.cwd));
    return agents
      ? { code: 'UNIDENTIFIED_LAUNCHER', message: UNIDENTIFIED_LAUNCHER_MESSAGE }
      : null;
  }
  const own = realOr(launcher.agentPath);
  if (place.agentPath !== undefined && realOr(place.agentPath) !== own) {
    return { code: 'NOT_THE_CALLER', message: NOT_THE_CALLER_MESSAGE };
  }
  if (place.chatAgent && realOr(place.chatAgent) !== own) {
    return { code: 'OTHER_AGENTS_CHAT', message: OTHER_AGENTS_CHAT_MESSAGE };
  }
  if (place.cwd !== undefined && isOtherAgentsFolder(meshCore, place.cwd, launcher.agentPath)) {
    return { code: 'OTHER_AGENTS_FOLDER', message: OTHER_AGENTS_HOME_MESSAGE };
  }
  return null;
}

/**
 * What the chat's binding records as having launched it: the agent's Mesh id,
 * its home when Mesh cannot name it, or `unidentified`. `undefined` for a
 * person, whose own chat needs no such note.
 *
 * @param meshCore - Mesh, which names each registered home.
 * @param launcher - Who chose the place.
 */
export function launchedByOf(
  meshCore: Pick<MeshCore, 'listWithPaths'> | undefined,
  launcher: SessionLauncher
): string | undefined {
  if (launcher.kind === 'person') return undefined;
  if (launcher.kind === 'unidentified') return 'unidentified';
  const own = realOr(launcher.agentPath);
  const agent = (meshCore?.listWithPaths() ?? []).find((a) => realOr(a.projectPath) === own);
  return agent?.id ?? launcher.agentPath;
}
