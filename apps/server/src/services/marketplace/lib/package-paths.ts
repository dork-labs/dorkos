/**
 * Path-safety guards for caller-supplied marketplace package names.
 *
 * Package names arrive from the network — the `:name` param on every
 * `/api/marketplace/packages/:name/*` route, the `name` argument of the
 * `marketplace_install` / `marketplace_uninstall` MCP tools — and are then
 * joined into filesystem paths: an install root under `dorkHome`, a directory
 * under the marketplace cache. `path.join` collapses `..` silently, so a name
 * nobody checked can aim the uninstall flow's recursive delete, or the cache's
 * clone-and-rename, at any directory the caller likes.
 *
 * Two guards, because the two seams admit different names:
 *
 * - {@link assertPackageName} is the strict one. An installed package's
 *   directory is always its manifest `name`, which the manifest schema pins to
 *   {@link PackageNameSchema} (kebab-case, 1-64 chars) — and the harness's
 *   `.claude-plugin/plugin.json` fallback re-validates against the same schema
 *   for the same reason. Anything else can never name a real install, so
 *   uninstall refuses it outright.
 * - {@link assertPathSegment} is the permissive one, for names that are only
 *   ever cache keys. A git package name is whatever the caller typed to the
 *   left of the `@`, or the repo segment of `github:user/repo` — names with
 *   dots or capitals that never become an install directory. Refusing those
 *   would break working installs, so this guard checks only what containment
 *   actually requires: one path segment, no traversal, no null bytes.
 *
 * {@link assertContainedIn} is the belt to those braces: a resolved path that
 * must stay under a known root, asserted at the seam that builds it.
 *
 * @module services/marketplace/lib/package-paths
 */
import path from 'node:path';
import { PackageNameSchema } from '@dorkos/marketplace';

/**
 * Base class for every refusal in this module, so a caller that only wants to
 * answer "the caller named something it may not name" can catch one type.
 */
export class MarketplacePathError extends Error {
  /**
   * Build a path refusal.
   *
   * @param message - Human-readable explanation, safe to return to the caller.
   */
  constructor(message: string) {
    super(message);
    this.name = 'MarketplacePathError';
  }
}

/** Thrown when a package name cannot safely become a filesystem path segment. */
export class InvalidPackageNameError extends MarketplacePathError {
  /**
   * Build an invalid-name refusal.
   *
   * @param packageName - The name the caller supplied.
   * @param reason - Why it was refused, phrased for the person who sent it.
   */
  constructor(
    public readonly packageName: string,
    public readonly reason: string
  ) {
    super(`Invalid package name '${packageName}': ${reason}`);
    this.name = 'InvalidPackageNameError';
  }
}

/** Thrown when a derived path resolves outside the root it must stay under. */
export class PathEscapeError extends MarketplacePathError {
  /**
   * Build a containment refusal.
   *
   * @param root - The directory the path had to stay under.
   * @param candidate - The path that escaped it.
   */
  constructor(
    public readonly root: string,
    public readonly candidate: string
  ) {
    super(`Path '${candidate}' resolves outside '${root}'`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Upper bound on a cache-key name. Well past any real repository name and far
 * short of a path length any filesystem would accept.
 */
const MAX_SEGMENT_LENGTH = 128;

/**
 * Assert that `name` is a canonical package name — the only shape an installed
 * package directory ever has.
 *
 * @param name - The caller-supplied package name.
 * @returns The name, unchanged, so call sites can use this inline.
 * @throws {InvalidPackageNameError} When the name is not kebab-case.
 */
export function assertPackageName(name: string): string {
  if (!PackageNameSchema.safeParse(name).success) {
    throw new InvalidPackageNameError(
      name,
      'must be 1-64 characters of lowercase letters, digits and single hyphens'
    );
  }
  return name;
}

/**
 * Assert that `name` is a single, traversal-free path segment.
 *
 * Deliberately looser than {@link assertPackageName}: this is for names that
 * only ever become a cache key, where the caller's own spelling (dots,
 * capitals, underscores) is legitimate and only containment is at stake.
 *
 * @param name - The caller-supplied package name.
 * @returns The name, unchanged.
 * @throws {InvalidPackageNameError} When the name could escape its directory.
 */
export function assertPathSegment(name: string): string {
  const refuse = (reason: string): never => {
    throw new InvalidPackageNameError(name, reason);
  };
  if (name.length === 0) refuse('must not be empty');
  if (name.length > MAX_SEGMENT_LENGTH) {
    refuse(`must be at most ${MAX_SEGMENT_LENGTH} characters`);
  }
  if (name.includes('\0')) refuse('must not contain a null byte');
  if (name.includes('/') || name.includes('\\')) refuse('must not contain a path separator');
  // With separators already refused, `..` can only be the whole name — an
  // embedded `a..b` is an ordinary directory name, not a climb.
  if (name === '.' || name === '..') refuse('must not be a relative path segment');
  return name;
}

/**
 * Assert that `candidate` resolves to `root` itself or to something nested
 * under it.
 *
 * The `path.sep` suffix is what stops a prefix collision — without it,
 * `/cache/packages-evil` reads as living under `/cache/packages`.
 *
 * @param root - The directory the path must stay under.
 * @param candidate - The path to check.
 * @returns `candidate`, unchanged, so call sites can return it directly.
 * @throws {PathEscapeError} When the path resolves outside `root`.
 */
export function assertContainedIn(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapeError(root, candidate);
  }
  return candidate;
}
