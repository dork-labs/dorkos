import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { resolveDorkHome } from './dork-home.js';

/**
 * Centralized directory boundary enforcement utility.
 *
 * Provides path validation to ensure all filesystem operations are restricted
 * to a configured root directory. Must be initialized at server startup via
 * `initBoundary()` before any validation calls.
 *
 * Two validators exist, and the choice between them is a security decision:
 *
 * - {@link validateBoundary} confines a path to the configured boundary root.
 *   Use it for every RAW FILE/CONTENT surface — file reads/writes, terminal,
 *   git, diff, uploads, directory browsing, marketplace installs. The boundary
 *   exists to keep these off the operator's wider disk (and, deliberately, off
 *   DorkOS's own data directory, which holds an encrypted runtime-credential
 *   store under `{dorkHome}/extension-secrets/`).
 * - {@link validateBoundaryOrDorkHome} additionally accepts DorkOS's own data
 *   directory (`resolveDorkHome()`). Use it ONLY for AGENT-REGISTRY operations
 *   that key off an agent manifest path — the system agent (DorkBot) and
 *   marketplace-installed agents live under `{dorkHome}/agents/*` BY DESIGN, so
 *   confining these to a user-project boundary would 403 legitimate work (e.g.
 *   applying DorkBot's persona during onboarding in a `DORKOS_BOUNDARY`-scoped
 *   Docker deployment). Never reach for it from a raw file surface — that would
 *   widen file access into the credential store.
 *
 * ## The `os.homedir()` calls here (a declared carve-out)
 *
 * `os.homedir()` is banned in server code (Hard Rule 3) because DorkOS's own
 * data directory is `resolveDorkHome()`, which is NOT the home directory
 * whenever `DORK_HOME` is redirected. This module is one of the rule's declared
 * carve-outs, listed with the others in `.claude/rules/dork-home.md`. It is the
 * only one granted per CALL SITE rather than per file: the two calls below carry
 * inline disables, so a third one added anywhere else in this file is still a
 * lint error.
 *
 * Both calls mean *the person's home*, and reaching them for dork-home would be
 * its own bug:
 *
 * - {@link initBoundary}'s default root — with no boundary configured, DorkOS
 *   may reach anywhere under the home directory of whoever ran it. Confining
 *   that to dork-home would refuse every real project path.
 * - {@link expandTilde} — a `~` in a path a PERSON supplied means their home.
 *   Resolving it anywhere else would silently redirect a directory they chose
 *   for themselves.
 *
 * The carve-out stops there, and this is the part that had actually gone wrong:
 * it does not extend to DorkOS's own defaults. A default that merely SPELLS a
 * DorkOS directory with a `~` (`agents.defaultDirectory`) must be resolved
 * against dork-home, through `lib/agents-home.ts`. Putting that one through
 * {@link expandTilde} wrote newly created agents into an operator's real
 * `~/.dork/agents` from a dev tree (DOR-662).
 *
 * One gap worth knowing, since this header argues at length about "the person's
 * home": the lint guard covers `os.homedir()`, not the env vars underneath it.
 * `process.env.HOME` and `process.env.USERPROFILE` reach the same directory and
 * are only a `no-restricted-syntax` WARNING (the general process.env rule), so
 * they would slip past. Nothing in the server reads them today.
 *
 * @module lib/boundary
 */

/** Error thrown when a path violates the directory boundary. */
export class BoundaryError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
  }
}

/** Resolved boundary root, set once at startup via initBoundary(). */
let resolvedBoundary: string | null = null;

/**
 * Initialize the boundary root. Must be called once at server startup.
 * Resolves symlinks and stores the canonical path.
 *
 * @param boundary - Configured boundary path, or null/undefined for os.homedir()
 * @returns The resolved canonical boundary path
 */
export async function initBoundary(boundary?: string | null): Promise<string> {
  // eslint-disable-next-line no-restricted-properties -- declared carve-out (see module header): with no boundary configured, the reachable area IS the operator's home, not dork-home
  const raw = boundary ?? os.homedir();
  resolvedBoundary = await fs.realpath(raw);
  return resolvedBoundary;
}

/**
 * Get the resolved boundary path.
 *
 * @throws Error if initBoundary() hasn't been called yet
 */
export function getBoundary(): string {
  if (!resolvedBoundary) {
    throw new Error('Boundary not initialized. Call initBoundary() at startup.');
  }
  return resolvedBoundary;
}

/**
 * Expand a leading `~` or `~/` in a **person-supplied** path to their home
 * directory.
 *
 * Node.js filesystem APIs don't expand tilde, so this normalizes paths a person
 * typed — a directory override, a configured scan root — before resolution.
 *
 * **Not for DorkOS's own defaults.** The home directory is not DorkOS's data
 * directory: `DORK_HOME` moves the latter and leaves the former alone. A
 * default that spells a DorkOS path with a `~` must go through
 * `resolveAgentsDirectory()` in `lib/agents-home.ts`, which resolves it against
 * the data directory actually in use. See that module and the `os.homedir()`
 * note in this one's header (DOR-662).
 *
 * @param userPath - Path that may start with `~`
 * @returns Path with tilde expanded to `os.homedir()`
 */
export function expandTilde(userPath: string): string {
  if (userPath !== '~' && !userPath.startsWith('~/')) return userPath;
  // eslint-disable-next-line no-restricted-properties -- declared carve-out (see module header): a `~` a PERSON typed means their home, not dork-home
  const home = os.homedir();
  return userPath === '~' ? home : path.join(home, userPath.slice(2));
}

/**
 * How many dangling-symlink hops {@link resolveThroughExistingAncestor} will
 * follow before refusing the path outright.
 *
 * Only a chain of links whose targets do NOT exist gets here. Such a chain
 * never resolves, so `fs.realpath` reports ENOENT rather than ELOOP no matter
 * how long it is — the kernel's own loop limit is never reached, and this is
 * the only limit standing.
 */
const MAX_DANGLING_SYMLINK_HOPS = 32;

/**
 * Join path segments WITHOUT normalizing, so a `..` survives to be resolved
 * against real directories later.
 *
 * `path.join` and `path.resolve` both collapse `..` as text, which is only
 * correct on a path with no unresolved symlinks left in it. Everywhere this
 * module still has symlinks ahead of it, segments are concatenated instead and
 * `fs.realpath` is left to do the collapsing.
 */
function joinRaw(base: string, ...segments: string[]): string {
  let joined = base;
  for (const segment of segments) {
    joined = joined.endsWith(path.sep) ? joined + segment : joined + path.sep + segment;
  }
  return joined;
}

/**
 * The link target if `candidate` is a symlink, or `null` if it is anything else
 * (including absent).
 *
 * `lstat` rather than `stat` on purpose: the question is whether this path IS a
 * link, not what it points at, and the caller only asks once `realpath` has
 * already failed to follow it.
 */
async function readlinkOrNull(candidate: string): Promise<string | null> {
  try {
    const stats = await fs.lstat(candidate);
    if (!stats.isSymbolicLink()) return null;
    return await fs.readlink(candidate);
  } catch {
    return null;
  }
}

/**
 * Resolve a path that does not exist by canonicalizing the part of it that DOES.
 *
 * `fs.realpath` is all-or-nothing: one missing component and it throws, telling
 * you nothing about the components that were real. Falling back to a lexical
 * `path.resolve` there — which this module did until DOR-1185 — judges the path
 * by its spelling, so a non-existent CHILD of a symlink escaped every
 * containment check that followed (`{dorkHome}/agents/<symlink>/nope` read as
 * living under `agents/` while pointing anywhere at all).
 *
 * So: climb until an ancestor resolves, canonicalize THAT, and re-append the
 * missing tail. Every symlink on the existing part is followed, because those
 * are the components a write would actually traverse, and the tail is joined
 * onto a canonical directory — where collapsing `..` as text is finally correct,
 * there being no symlinks left in it to collapse across.
 *
 * Which is why the climb itself never calls `path.resolve`. Collapsing `..`
 * lexically up front would relocate the path BEFORE any symlink on it were
 * followed: `{root}/link/../evil` with `link -> /outside` reads as `{root}/evil`
 * and passes, while the real traversal leaves through `link` first. Stripping
 * components with `path.dirname` instead leaves a `..` on the existing part for
 * `fs.realpath` to resolve against the directory the link actually leads to.
 *
 * The first missing component gets one extra question, since "missing" and
 * "dangling symlink" are the same ENOENT: if it is a link, its target is
 * resolved the same way. Otherwise a link planted at a not-yet-written file
 * would still be judged by its name.
 *
 * @param input - Absolute or relative path whose leaf does not exist
 * @param hops - Dangling-symlink hops already taken (budget guard)
 * @returns The deepest existing ancestor, canonicalized, with the missing tail re-appended
 * @throws BoundaryError on EACCES (`PERMISSION_DENIED`) while climbing, or when the
 *   dangling-symlink budget runs out (`OUTSIDE_BOUNDARY`)
 */
async function resolveThroughExistingAncestor(input: string, hops = 0): Promise<string> {
  // Made absolute by concatenation, not `path.resolve` — see the note above.
  let ancestor = path.isAbsolute(input) ? input : joinRaw(process.cwd(), input);
  const missingTail: string[] = [];

  for (;;) {
    const parent = path.dirname(ancestor);
    // Reached the filesystem root without finding anything real. Nothing to
    // canonicalize against, so the normalized spelling is the best answer —
    // and it is a safe one, since no symlink was skipped to get here.
    if (parent === ancestor) return path.resolve(ancestor);

    missingTail.unshift(path.basename(ancestor));
    ancestor = parent;

    let real: string;
    try {
      real = await fs.realpath(ancestor);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      if (code === 'EACCES') {
        throw new BoundaryError('Permission denied', 'PERMISSION_DENIED');
      }
      throw err;
    }

    // `ancestor` resolves, so the failure was at `missingTail[0]` — either it is
    // absent, or it is a symlink whose target is.
    const [head, ...rest] = missingTail;
    const linkTarget = await readlinkOrNull(path.join(real, head));
    if (linkTarget === null) return path.join(real, ...missingTail);

    // Out of budget with a symlink still unfollowed. REFUSE rather than answer:
    // returning what the walk had reached would name a location one link short
    // of the link it gave up on, which is a write target on the far side of
    // whatever that link points at. An unfinished resolution is not an answer.
    if (hops >= MAX_DANGLING_SYMLINK_HOPS) {
      throw new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
    }

    return resolveThroughExistingAncestor(
      joinRaw(path.resolve(real, linkTarget), ...rest),
      hops + 1
    );
  }
}

/**
 * Reject null bytes, expand a leading tilde, and resolve symlinks to a
 * canonical path. Shared resolution step for both boundary validators so their
 * null-byte / ENOENT / EACCES behavior stays identical.
 *
 * Paths that do not exist yet still validate — a workspace about to be cloned,
 * an agent directory about to be created, a workbench file about to be written
 * — but they are canonicalized as far as they are real rather than judged
 * lexically. See {@link resolveThroughExistingAncestor}.
 *
 * @param userPath - User-supplied path (absolute or tilde-prefixed)
 * @returns Resolved canonical path (symlinks followed as far as the path exists)
 * @throws BoundaryError on null bytes (`NULL_BYTE`) or EACCES (`PERMISSION_DENIED`)
 */
async function resolveCanonicalPath(userPath: string): Promise<string> {
  // Reject null bytes — prevents null byte injection attacks
  if (userPath.includes('\0')) {
    throw new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE');
  }

  // Expand leading tilde before any filesystem resolution
  const expanded = expandTilde(userPath);

  // Resolve symlinks to their real target
  try {
    return await fs.realpath(expanded);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return resolveThroughExistingAncestor(expanded);
    }
    if (code === 'EACCES') {
      throw new BoundaryError('Permission denied', 'PERMISSION_DENIED');
    }
    throw err;
  }
}

/**
 * Whether `resolved` is `root` itself or nested within it.
 *
 * Uses a `path.sep` suffix to prevent prefix collision — without it, boundary
 * `/home/user` would incorrectly allow `/home/username`.
 *
 * @param resolved - Canonical path to test
 * @param root - Canonical containment root
 */
function isContained(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Realpath-resolved DorkOS data directory, cached by its raw value.
 *
 * Dork-home is stable within a process, but tests (and the embedded transport)
 * repoint `DORK_HOME`, so the cache is keyed on the raw `resolveDorkHome()`
 * value and re-resolves when it changes.
 */
let cachedDorkHome: { raw: string; resolved: string } | null = null;

/**
 * Resolve DorkOS's data directory to its canonical (symlink-followed) path.
 *
 * Realpath-resolving here mirrors `initBoundary()` so a symlinked dork-home
 * can't be used to spoof the containment check. When the directory doesn't
 * exist yet it resolves through its deepest existing ancestor, the same rule
 * {@link resolveCanonicalPath} applies to the path being validated — otherwise
 * a dork-home nested under a symlink would be compared against a location
 * neither side actually reaches.
 */
async function resolveDorkHomeReal(): Promise<string> {
  const raw = resolveDorkHome();
  if (cachedDorkHome?.raw === raw) return cachedDorkHome.resolved;
  let resolved: string;
  try {
    resolved = await fs.realpath(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      resolved = await resolveThroughExistingAncestor(raw);
    } else {
      throw err;
    }
  }
  cachedDorkHome = { raw, resolved };
  return resolved;
}

/**
 * Validate that a path is within the directory boundary.
 *
 * Expands leading `~` to the home directory, then resolves symlinks before
 * checking containment to prevent symlink-based boundary escapes. A path that
 * does not exist yet still validates — session creation, workspace
 * provisioning and file creation all depend on that — but it is canonicalized
 * through its deepest existing ancestor, so a symlink on the part that IS real
 * is followed rather than read as text.
 *
 * @param userPath - User-supplied path to validate (absolute or tilde-prefixed)
 * @param boundary - Optional boundary override (defaults to initialized boundary)
 * @returns Resolved canonical path
 * @throws BoundaryError if path is outside boundary, contains null bytes, or permission is denied
 */
export async function validateBoundary(userPath: string, boundary?: string): Promise<string> {
  const root = boundary ?? getBoundary();
  const resolved = await resolveCanonicalPath(userPath);

  if (!isContained(resolved, root)) {
    throw new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
  }

  return resolved;
}

/**
 * Validate that a path is within the directory boundary OR within DorkOS's own
 * data directory (`resolveDorkHome()`).
 *
 * This is the AGENT-REGISTRY seam. The directory boundary confines access to
 * user project paths, but DorkOS's system agent (DorkBot) and every
 * marketplace-installed agent live under `{dorkHome}/agents/*` by design.
 * Agent-registry operations that key off an agent manifest path must therefore
 * treat the `{dorkHome}/agents` subtree as always in-bounds — otherwise a boundary-scoped deployment
 * (e.g. Docker with `DORKOS_BOUNDARY=/workspace`) 403s legitimate work like
 * applying DorkBot's persona during onboarding.
 *
 * The allowance is deliberately NARROW: only callers that operate on agent
 * paths use this. Raw file/terminal/git/diff surfaces keep {@link validateBoundary}
 * so dork-home's encrypted runtime-credential store (`{dorkHome}/extension-secrets/`)
 * is never reachable through a file API. Null-byte, EACCES, and symlink handling
 * are identical to {@link validateBoundary}; dork-home is realpath-resolved so a
 * symlink can't spoof containment.
 *
 * @param userPath - User-supplied agent path to validate (absolute or tilde-prefixed)
 * @param boundary - Optional boundary override (defaults to initialized boundary)
 * @returns Resolved canonical path
 * @throws BoundaryError if path is outside both roots, contains null bytes, or permission is denied
 */
export async function validateBoundaryOrDorkHome(
  userPath: string,
  boundary?: string
): Promise<string> {
  const root = boundary ?? getBoundary();
  const resolved = await resolveCanonicalPath(userPath);

  if (isContained(resolved, root)) {
    return resolved;
  }

  // Narrowed to the agents subtree (not all of dork-home): every legitimate
  // agent lives under {dorkHome}/agents/*, and this keeps sibling dirs like
  // the encrypted credential store out of reach even for manifest writes.
  const dorkHome = await resolveDorkHomeReal();
  if (isContained(resolved, path.join(dorkHome, 'agents'))) {
    return resolved;
  }

  throw new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
}

/**
 * Check if a path is within the boundary without throwing.
 *
 * @param userPath - User-supplied path to check
 * @param boundary - Optional boundary override (defaults to initialized boundary)
 * @returns true if the path is within the boundary, false otherwise
 */
export async function isWithinBoundary(userPath: string, boundary?: string): Promise<boolean> {
  try {
    await validateBoundary(userPath, boundary);
    return true;
  } catch {
    return false;
  }
}
