/**
 * Which agent's home a folder belongs to (spec `agent-home-desk` §3, DOR-2355).
 *
 * An agent's identity — its persona, `SOUL.md`, `NOPE.md`, memory, tool groups,
 * account pin and runtime choice — lives in exactly one place: the folder the
 * agent is registered at, its **home**. A turn does not always stand there. It
 * may stand in a git worktree of the agent's own repo or a managed checkout the
 * agent owns. Each of those can carry a committed `.dork/` that is stale or
 * somebody else's, so reading identity off the folder a turn stands in let a
 * branch decide who an agent is. A room turn stands at home and reaches the
 * room's files through folder grants (§5), so a room worktree is never a desk
 * and a folder inside one resolves to no agent.
 *
 * This module is the one answer to "whose home is this folder?", and its
 * answer is a branded {@link AgentHome}. The identity readers take that brand,
 * never a working directory, so reading identity from a raw folder is a type
 * error on the server.
 *
 * ## The owner sources, first match wins
 *
 * 1. **Exact.** The folder is a registered home.
 * 2. **A managed workspace** whose checkout is exactly this folder and whose
 *    owner is a registered agent. Checked before source 3 because a managed
 *    checkout is itself a linked worktree of its SOURCE repo, and an agent can
 *    own a checkout of another agent's repo (01-ideation decision 9): the owner,
 *    not the source, is who works there — and a record whose owner is no
 *    longer registered is refused, never handed on to the source's agent.
 * 3. **A linked worktree of a home repo**, read from the filesystem with no
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
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';

/**
 * A registered agent home. Only {@link resolveAgentHome} mints one, so an
 * identity reader that takes this type cannot be handed a working directory.
 */
export type AgentHome = string & { readonly __brand: 'AgentHome' };

/** How a folder resolved to a home. */
export type HomeVia = 'exact' | 'managed-workspace' | 'linked-worktree' | 'turn-agent';

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
      reason: 'not-the-turns-agent' | 'unregistered-owner';
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

let registry: AgentHomeRegistry | undefined;

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

/**
 * Whether `target` is the rooms directory or anywhere inside it — a room's
 * shared files, its agents' copies, its canvas (spec `agent-home-desk` I3).
 * No turn ever stands there. `false` when no rooms directory is wired.
 *
 * @param target - An absolute folder.
 */
export function isInsideRoomsDir(target: string): boolean {
  return insideRoomsDir(path.resolve(target));
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
 * How the turn's folder was chosen, as the desk guard needs to know it.
 *
 * - `home` — the agent's own home was asked for (the default binding, and
 *   every room turn).
 * - `managed` — the agent's manifest asked for a checkout of its own.
 * - `none` — the agent is configured `workspace.mode: 'none'` and shares the
 *   operator's default folder.
 * - `boundary-refused` — the agent's home is outside what this server may
 *   touch, so the default folder answered instead.
 */
export type DeskBinding = 'home' | 'managed' | 'none' | 'boundary-refused';

/**
 * Map the session-cwd chain's answer to a {@link DeskBinding} (spec
 * `agent-home-desk` §3.4).
 *
 * The chain reports ONE rung, `default`, for both an agent configured
 * `workspace.mode: 'none'` and an agent whose home the boundary refused; only
 * the second carries a `degraded` reason. Anything else that names a folder
 * outright (`explicit`) is held to the strictest reading, `home`.
 *
 * @param resolved - The rung that answered and why it degraded, if it did.
 */
export function deskBindingFor(resolved: { rung: string; degraded?: string }): DeskBinding {
  if (resolved.rung === 'agent-managed') return 'managed';
  if (resolved.rung === 'default') return resolved.degraded ? 'boundary-refused' : 'none';
  return 'home';
}

/**
 * A named-agent turn was about to stand somewhere that is not its desk
 * (spec `agent-home-desk` §3.4, invariant I3, DOR-2356). Thrown before the
 * runtime is called, so nothing ran.
 */
export class DeskNotOwnError extends Error {
  /** The stable code callers and logs key on. */
  readonly code = 'DESK_NOT_OWN';

  /**
   * Build the refusal.
   *
   * @param message - What happened and what to change, in plain words.
   * @param cwd - The folder that was refused.
   * @param forAgent - The home of the agent the turn was for.
   */
  constructor(
    message: string,
    readonly cwd: string,
    readonly forAgent: string
  ) {
    super(message);
    this.name = 'DeskNotOwnError';
  }
}

/**
 * Refuse a turn dispatched AS `forAgent` that would stand anywhere but its own
 * desk (spec `agent-home-desk` §3.4). Checked in this order:
 *
 * 1. `cwd` is inside `<dorkHome>/rooms/` → refused: a room's folder is never a
 *    desk, and a room turn reaches the room's files through grants.
 * 2. `cwd` resolves to a home other than `forAgent` → refused: another agent's
 *    home, or a private copy of it. A folder whose owner cannot be shown is
 *    refused too.
 * 3. `cwd` is `forAgent`'s home, or resolves to it → allowed.
 * 4. `cwd` is the operator's default folder and `binding` is `none` or
 *    `boundary-refused` → allowed, unless that folder sits inside another
 *    agent's home; identity still comes from `forAgent`.
 * 5. Anything else → refused.
 *
 * **Step 2 wins over step 4 on purpose.** In a DorkOS dev checkout the default
 * folder falls back to the repo root, which is the `dorkos` agent's own home;
 * a `none` agent's task there would read and write that agent's folder.
 *
 * @param forAgent - The home of the agent the turn is dispatched as.
 * @param cwd - Where the turn is about to stand.
 * @param binding - How `cwd` was chosen — see {@link deskBindingFor}.
 * @param defaultCwd - The operator's default folder; the server's own by default.
 * @throws {DeskNotOwnError} When `cwd` is not this agent's desk.
 */
export function assertOwnDesk(
  forAgent: string,
  cwd: string,
  binding: DeskBinding,
  defaultCwd: string = DEFAULT_CWD
): void {
  const dir = path.resolve(cwd);
  const refuse = (message: string): never => {
    throw new DeskNotOwnError(message, dir, forAgent);
  };
  if (insideRoomsDir(dir)) {
    refuse(
      `This turn was about to run inside a room's files ("${dir}"), which is never where an ` +
        `agent works. It reaches a room's files from its own folder instead.`
    );
  }
  const own = canonicalHome(path.resolve(forAgent)) ?? realPathOr(forAgent);
  const found = resolveFolder(dir);
  if (found.kind === 'refused' || (found.kind === 'home' && found.home !== own)) {
    const shared = binding === 'none' || binding === 'boundary-refused';
    refuse(
      `"${dir}" belongs to another agent, so this agent can't work there. ` +
        (shared
          ? `This agent is set to use the default folder, and that folder is another agent's ` +
            `home. Set a default folder that belongs to no agent, or give this agent a folder ` +
            `of its own.`
          : `Give this agent a folder of its own.`)
    );
  }
  if (found.kind === 'home' || realPathOr(dir) === realPathOr(forAgent)) return;
  if ((binding === 'none' || binding === 'boundary-refused') && sameRealPath(dir, defaultCwd)) {
    // The default folder is only a shared desk when it is nobody's: one INSIDE
    // another agent's home (the CLI sets it from wherever `dorkos` started) is
    // that agent's folder, even though no home sits at exactly that path.
    const owner = enclosingOtherHome(dir, own);
    if (owner !== null) {
      refuse(
        `"${dir}" is inside another agent's folder (${owner}), so this agent can't work there. ` +
          `This agent is set to use the default folder. Set a default folder that belongs to ` +
          `no agent, or give this agent a folder of its own.`
      );
    }
    return;
  }
  refuse(
    `"${dir}" is not this agent's own folder or a private copy of it, so the turn was not ` +
      `started. Check where this agent is set to work.`
  );
}

/**
 * Refuse a turn that names NO agent but would stand in a folder that is some
 * agent's or a room's — a room's files, a registered home, a folder inside one,
 * or a private copy of one. Standing there would read and write that agent's
 * folder, and resolve to its identity, on nobody's say-so.
 *
 * @param cwd - Where the turn is about to stand.
 * @throws {DeskNotOwnError} When the folder belongs to an agent or a room.
 */
export function assertNobodysDesk(cwd: string): void {
  const dir = path.resolve(cwd);
  const owned =
    insideRoomsDir(dir) ||
    resolveFolder(dir).kind !== 'none' ||
    enclosingOtherHome(dir, '\0nobody') !== null;
  if (owned) {
    throw new DeskNotOwnError(
      `"${dir}" belongs to an agent or a room, and this message names no agent to run as ` +
        `there, so it was not run.`,
      dir,
      ''
    );
  }
}

/**
 * The registered home, other than `own`, that `dir` sits in (at any depth), or
 * `null`. Compared on real paths, so a symlinked spelling cannot slip past.
 *
 * @param dir - An absolute folder.
 * @param own - The turn's agent's home, which never counts.
 */
function enclosingOtherHome(dir: string, own: string): string | null {
  if (!registry) return null;
  let homes: readonly string[];
  try {
    homes = registry.listRegisteredHomes();
  } catch {
    return null;
  }
  const target = realPathOr(dir);
  const ownReal = realPathOr(own);
  for (const home of homes) {
    const real = realPathOr(home);
    if (real === ownReal) continue;
    const rel = path.relative(real, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return home;
  }
  return null;
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
