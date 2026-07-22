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
 * Expand a leading `~` or `~/` in a user-supplied path to the home directory.
 *
 * Node.js filesystem APIs don't expand tilde — this normalizes user-supplied
 * paths (e.g., from config values like `~/.dork/agents`) before resolution.
 *
 * @param userPath - Path that may start with `~`
 * @returns Path with tilde expanded to `os.homedir()`
 */
export function expandTilde(userPath: string): string {
  if (userPath === '~') return os.homedir();
  if (userPath.startsWith('~/')) return path.join(os.homedir(), userPath.slice(2));
  return userPath;
}

/**
 * Reject null bytes, expand a leading tilde, and resolve symlinks to a
 * canonical path. Shared resolution step for both boundary validators so their
 * null-byte / ENOENT / EACCES behavior stays identical.
 *
 * For non-existent paths (ENOENT), falls back to `path.resolve()` so session
 * creation for new directories still validates.
 *
 * @param userPath - User-supplied path (absolute or tilde-prefixed)
 * @returns Resolved canonical path (symlinks followed when the path exists)
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
      // Path doesn't exist yet (e.g., new session directory) — resolve without symlink follow
      return path.resolve(expanded);
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
 * can't be used to spoof the containment check. Falls back to `path.resolve()`
 * when the directory doesn't exist yet (ENOENT).
 */
async function resolveDorkHomeReal(): Promise<string> {
  const raw = resolveDorkHome();
  if (cachedDorkHome?.raw === raw) return cachedDorkHome.resolved;
  let resolved: string;
  try {
    resolved = await fs.realpath(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      resolved = path.resolve(raw);
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
 * checking containment to prevent symlink-based boundary escapes. For
 * non-existent paths (ENOENT), falls back to `path.resolve()` so session
 * creation for new directories still validates.
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
