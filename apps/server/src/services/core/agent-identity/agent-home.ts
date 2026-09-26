/**
 * Which agent's home a folder belongs to (spec `agent-home-desk` §3, DOR-2355).
 *
 * An agent's identity — its persona, `SOUL.md`, `NOPE.md`, memory, tool groups,
 * account pin and runtime choice — lives in exactly one place: the folder the
 * agent is registered at, its **home**. A turn does not always stand there. It
 * may stand in a git worktree of the agent's own repo, a managed checkout the
 * agent owns, or (until spec task T4) a room worktree. Each of those can carry
 * a committed `.dork/` that is stale or somebody else's, so reading identity
 * off the folder a turn stands in let a branch decide who an agent is.
 *
 * This module is the one answer to "whose home is this folder?", and its
 * answer is a branded {@link AgentHome}. The identity readers take that brand,
 * never a working directory, so reading identity from a raw folder is a type
 * error on the server.
 *
 * ## The owner sources, first match wins
 *
 * 1. **A room working copy** the room worktree manager handed out, anchored to
 *    the agent it was handed to (DOR-2091), or refused when it cannot vouch for
 *    one. Kept until T4 moves room turns home.
 * 2. **Exact.** The folder is a registered home.
 * 3. **A managed workspace** whose checkout is exactly this folder and whose
 *    owner is a registered agent. Checked before source 4 because a managed
 *    checkout is itself a linked worktree of its SOURCE repo, and an agent can
 *    own a checkout of another agent's repo (01-ideation decision 9): the owner,
 *    not the source, is who works there — and a record whose owner is no
 *    longer registered is refused, never handed on to the source's agent.
 * 4. **A linked worktree of a home repo**, read from the filesystem with no
 *    `git` process: the folder's `.git` file, git's own backlink to it, and the
 *    repo's `commondir`. The folder at the same relative position in the main
 *    worktree must itself be a registered home — never a walk up past it.
 *
 * A path prefix is never an owner source. Every home is compared canonically —
 * the same folder spelled through a symlink is the same home — and answered in
 * the registry's own spelling (see {@link canonicalHome}).
 *
 * ## Who the turn is for
 *
 * A server path that dispatches a turn AS a named agent (a room, a relay
 * binding, a task) passes that agent as `forAgent`. When the folder resolves to
 * a different home the answer is refused, so a turn for one agent can never act
 * as another. When the folder resolves to no home at all — the operator's
 * default directory for an agent configured `workspace.mode: 'none'`, or a
 * subfolder of the agent's own home — identity comes from the turn's agent
 * (01-ideation decision 10): the server said whose turn it is, and "nobody"
 * would hand a login-off install's tools to the operator.
 *
 * @module services/core/agent-identity/agent-home
 */
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from '@dorkos/shared/manifest';

/**
 * A registered agent home. Only {@link resolveAgentHome} mints one, so an
 * identity reader that takes this type cannot be handed a working directory.
 */
export type AgentHome = string & { readonly __brand: 'AgentHome' };

/** How a folder resolved to a home. */
export type HomeVia =
  'exact' | 'room-worktree' | 'managed-workspace' | 'linked-worktree' | 'turn-agent';

/**
 * The answer for one folder.
 *
 * - `home` — identity comes from `home`.
 * - `none` — no agent: a session about a directory.
 * - `refused` — the folder is some agent's, and it cannot be shown to be the
 *   turn's. Acts as nobody, and never as the operator.
 */
export type HomeResolution =
  | { kind: 'home'; home: AgentHome; via: HomeVia }
  | { kind: 'none' }
  | {
      kind: 'refused';
      reason: 'not-the-turns-agent' | 'unregistered-owner' | 'unowned-working-copy';
    };

/**
 * What the resolver needs from the rest of the server, wired once at boot.
 *
 * Absent (a unit test that wires nothing), no folder is a registered home and
 * every answer is `none` or `refused` — never an identity read off the folder.
 */
export interface AgentHomeRegistry {
  /** Whether `dir` is, exactly as spelled, a registered agent's home right now. */
  isRegisteredHome(dir: string): boolean;
  /**
   * Every registered home, in the registry's own spelling. Read only when an
   * exact lookup misses, so a folder reached through a symlink (or a `/tmp` vs
   * `/private/tmp` spelling) still finds the home it IS — see
   * {@link canonicalHome}.
   */
  listRegisteredHomes(): readonly string[];
  /**
   * The owning agent's home when `dir` is a managed workspace's checkout owned
   * by an agent, else `null`. Implementations compare canonically: the store
   * may hold a realpath'd spelling of either side.
   */
  managedWorkspaceOwner(dir: string): string | null;
  /** `<dorkHome>/rooms`: no repo under it is ever an agent's home repo. */
  roomsDir: string | null;
}

/**
 * What the room worktree manager knows about one directory.
 *
 * Declared here and implemented in the rooms domain, so a runtime can ask this
 * question without importing a room type. Removed with the room-worktree owner
 * source in spec task T4.
 */
export interface WorkingCopyOwnerPort {
  /**
   * Whether `dir` is a room working copy, and if so, whose.
   *
   * @param dir - An absolute directory.
   * @returns `null` when `dir` is not a room working-copy location at all;
   *   otherwise `{ owner }`, where `owner` is the agent path the manager handed
   *   this exact directory to, or `null` when it cannot vouch for one.
   */
  ownerOf(dir: string): { owner: string | null } | null;
}

let registry: AgentHomeRegistry | undefined;
let workingCopies: WorkingCopyOwnerPort | undefined;

/**
 * Register (or clear) the registry side of the resolver.
 *
 * @param port - The live registry lookups, or `undefined` to clear them.
 */
export function setAgentHomeRegistry(port: AgentHomeRegistry | undefined): void {
  registry = port;
  linkedWorktreeMemo.clear();
}

/**
 * Register (or clear) the room worktree manager's owner record.
 *
 * @param port - The manager's lookup, or `undefined` to clear it.
 */
export function setWorkingCopyOwnerPort(port: WorkingCopyOwnerPort | undefined): void {
  workingCopies = port;
}

/**
 * Resolve the folder a turn stands in to the home its identity comes from.
 *
 * Synchronous and cheap — a registry read, and for a linked worktree three
 * small file reads — because every runtime asks it on the turn path.
 *
 * @param dir - Where the turn stands, or `undefined` when nothing names it.
 * @param forAgent - The home of the agent the turn is dispatched as, when a
 *   server path names one (room, relay binding, task).
 */
export function resolveAgentHome(
  dir: string | undefined,
  forAgent?: string | undefined
): HomeResolution {
  const found: HomeResolution = dir ? resolveFolder(path.resolve(dir)) : { kind: 'none' };
  if (forAgent === undefined || found.kind === 'refused') return found;
  const turnAgent = canonicalHome(path.resolve(forAgent));
  if (found.kind === 'home') {
    return found.home === turnAgent ? found : { kind: 'refused', reason: 'not-the-turns-agent' };
  }
  return turnAgent !== null
    ? { kind: 'home', home: turnAgent, via: 'turn-agent' }
    : { kind: 'refused', reason: 'unregistered-owner' };
}

/**
 * The resolved home, or `undefined` when there is none to read identity from.
 *
 * @param resolution - A resolved folder.
 */
export function homeOf(resolution: HomeResolution): AgentHome | undefined {
  return resolution.kind === 'home' ? resolution.home : undefined;
}

/**
 * The agent a turn is dispatched as: the neutral `forAgent`, else the room
 * marker's `agentPath` (the field `forAgent` generalises).
 *
 * @param opts - The turn's message options.
 */
export function turnAgentOf(
  opts: { forAgent?: string; roomTurn?: { agentPath?: string } } | undefined
): string | undefined {
  return opts?.forAgent ?? opts?.roomTurn?.agentPath;
}

/**
 * Read an agent's manifest from its home — the server's only door to
 * `.dork/agent.json` for identity. `@dorkos/shared/manifest` keeps its string
 * signature for the CLI and other packages.
 *
 * @param home - A resolved home.
 */
export function readHomeManifest(home: AgentHome): ReturnType<typeof readManifest> {
  return readManifest(home);
}

/**
 * The owner sources for one absolute, normalized folder, with no turn agent.
 *
 * @param dir - The folder.
 */
function resolveFolder(dir: string): HomeResolution {
  // A room working copy first: the manager's record is the only answer for a
  // folder it handed out, and one it cannot vouch for is refused outright.
  const workingCopy = safeOwnerOf(dir);
  if (workingCopy) {
    if (workingCopy.owner === null) return { kind: 'refused', reason: 'unowned-working-copy' };
    const owner = canonicalHome(path.resolve(workingCopy.owner));
    if (owner === null) return { kind: 'refused', reason: 'unregistered-owner' };
    return { kind: 'home', home: owner, via: 'room-worktree' };
  }

  const exact = canonicalHome(dir);
  if (exact !== null) return { kind: 'home', home: exact, via: 'exact' };

  // A managed record that claims this folder is the whole answer. Falling
  // through to the linked-worktree source when its owner is gone would hand
  // Bob's checkout of Ana's repo to ANA — her persona, her account, her relay
  // identity — which is exactly the borrowing this module exists to stop.
  const managedOwner = safeManagedOwner(dir);
  if (managedOwner !== null) {
    const owner = canonicalHome(path.resolve(managedOwner));
    return owner !== null
      ? { kind: 'home', home: owner, via: 'managed-workspace' }
      : { kind: 'refused', reason: 'unregistered-owner' };
  }

  const candidate = linkedWorktreeCandidate(dir);
  const linked = candidate === null ? null : canonicalHome(candidate);
  if (linked !== null) return { kind: 'home', home: linked, via: 'linked-worktree' };
  return { kind: 'none' };
}

/**
 * The registered home `dir` IS, in the registry's own spelling, or `null`.
 *
 * Exact first (the hot path, one indexed read). On a miss, the same folder
 * reached by another spelling — a symlinked agents directory, macOS's `/tmp`
 * and `/private/tmp` — is found by comparing real paths, and answered with the
 * spelling the registry holds so every later `getByPath(home)` hits. Never a
 * prefix: two spellings of one folder, nothing wider.
 *
 * @param dir - An absolute, normalized folder.
 */
function canonicalHome(dir: string): AgentHome | null {
  if (!registry) return null;
  try {
    if (registry.isRegisteredHome(dir)) return dir as AgentHome;
    const real = realPathOr(dir);
    if (real !== dir && registry.isRegisteredHome(real)) return real as AgentHome;
    for (const home of registry.listRegisteredHomes()) {
      if (realPathOr(home) === real) return home as AgentHome;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask the room worktree manager, failing CLOSED: a lookup that throws cannot
 * vouch for anybody, so it answers "a working copy with no owner".
 */
function safeOwnerOf(dir: string): { owner: string | null } | null {
  if (!workingCopies) return null;
  try {
    return workingCopies.ownerOf(dir);
  } catch {
    return { owner: null };
  }
}

function safeManagedOwner(dir: string): string | null {
  if (!registry) return null;
  try {
    return registry.managedWorkspaceOwner(dir);
  } catch {
    // Cannot tell whether a record claims this folder: answer as if one does
    // and its owner is gone, rather than letting the linked-worktree source
    // hand the folder to its SOURCE repo's agent.
    return UNREADABLE_MANAGED_OWNER;
  }
}

/** A managed-owner lookup that threw: resolves to no registered home, so refused. */
const UNREADABLE_MANAGED_OWNER = '\0unreadable-managed-owner';

/**
 * The main worktree's candidate home for a linked worktree, keyed on the two
 * pointer files' contents so a worktree removed and re-added at the same path
 * — by another repo, or with a rewritten `.git` file — is a miss. Holds paths
 * only: whether a candidate is registered is asked live on every call.
 */
const linkedWorktreeMemo = new Map<string, { key: string; candidate: string | null }>();

/** Bounded so a long-lived server asked about many folders does not grow without end. */
const LINKED_WORKTREE_MEMO_MAX = 512;

/**
 * Map a folder inside a git linked worktree to the same relative folder in its
 * main worktree, from the filesystem alone.
 *
 * Refuses (answers `null`) for everything that is not plainly a linked worktree
 * git made: a `.git` directory (a main worktree), a `.git` file whose gitdir
 * has no backlink naming it (hand-written), no `commondir` (a submodule), a
 * bare common dir, and any repo under `<dorkHome>/rooms` (never a home repo,
 * so not even looked up).
 *
 * @param dir - An absolute, normalized folder.
 */
function linkedWorktreeCandidate(dir: string): string | null {
  const worktreeRoot = nearestGitAncestor(dir);
  if (worktreeRoot === null) return null;
  const dotGit = path.join(worktreeRoot, '.git');
  let pointer: string;
  try {
    if (fs.lstatSync(dotGit).isDirectory()) return null;
    pointer = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) return null;
  const gitDir = path.resolve(worktreeRoot, match[1]!);
  let backlink: string;
  try {
    backlink = fs.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
  } catch {
    return null;
  }

  const key = `${pointer}\0${backlink}`;
  const memo = linkedWorktreeMemo.get(dir);
  if (memo && memo.key === key) return memo.candidate;
  const candidate = mapLinkedWorktree(dir, worktreeRoot, dotGit, gitDir, backlink);
  if (linkedWorktreeMemo.size >= LINKED_WORKTREE_MEMO_MAX) linkedWorktreeMemo.clear();
  linkedWorktreeMemo.set(dir, { key, candidate });
  return candidate;
}

function mapLinkedWorktree(
  dir: string,
  worktreeRoot: string,
  dotGit: string,
  gitDir: string,
  backlink: string
): string | null {
  // git's own backlink: `<gitdir>/gitdir` names this worktree's `.git` file.
  // A hand-written pointer into another agent's repo has none that matches.
  if (!sameRealPath(path.resolve(gitDir, backlink), dotGit)) return null;
  let commonDirSpec: string;
  try {
    commonDirSpec = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
  } catch {
    // A submodule's `.git` file points at a gitdir with no `commondir`.
    return null;
  }
  const commonDir = path.resolve(gitDir, commonDirSpec);
  if (insideRoomsDir(commonDir)) return null;
  // A bare repo has no main worktree to be a home.
  if (path.basename(commonDir) !== '.git') return null;
  return path.join(path.dirname(commonDir), path.relative(worktreeRoot, dir));
}

function nearestGitAncestor(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function insideRoomsDir(target: string): boolean {
  const roomsDir = registry?.roomsDir;
  if (!roomsDir) return false;
  return [
    [roomsDir, target],
    [realPathOr(roomsDir), realPathOr(target)],
  ].some(([root, p]) => {
    const rel = path.relative(root!, p!);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function sameRealPath(a: string, b: string): boolean {
  return realPathOr(a) === realPathOr(b);
}

/**
 * A folder's real path, or its lexically resolved path when it does not exist.
 *
 * @param p - Any path.
 */
export function canonicalDir(p: string): string {
  return realPathOr(p);
}

function realPathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
