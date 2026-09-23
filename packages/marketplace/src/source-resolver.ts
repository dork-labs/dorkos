/**
 * @dorkos/marketplace — Pure source resolver.
 *
 * Interprets a `PluginSource` discriminated-union value into a flat
 * `ResolvedSourceDescriptor` ready to be consumed by the install pipeline
 * (server) or the README fetch layer (site). This is the single source of
 * truth for source-form interpretation — both the server and the site
 * call this function to avoid drift.
 *
 * Browser-safe — no Node.js dependencies; pure string manipulation only.
 *
 * @module @dorkos/marketplace/source-resolver
 */

import type { PluginSource } from './marketplace-json-schema.js';

/**
 * A resolved source descriptor. Callers dispatch on `type` to pick the
 * appropriate fetch/clone strategy. Relative-path values include the
 * `marketplaceRoot` so callers can materialize the final path without
 * re-passing context.
 */
export type ResolvedSourceDescriptor =
  | { type: 'relative-path'; path: string; marketplaceRoot: string }
  | { type: 'github'; repo: string; ref?: string; sha?: string; cloneUrl: string }
  | { type: 'url'; url: string; ref?: string; sha?: string }
  | { type: 'git-subdir'; cloneUrl: string; subpath: string; ref?: string; sha?: string }
  | { type: 'npm'; package: string; version?: string; registry?: string };

/** The descriptors git fetches from — the ones that always have a {@link SourceKey}. */
export type GitSourceDescriptor = Extract<
  ResolvedSourceDescriptor,
  { type: 'github' | 'url' | 'git-subdir' }
>;

/**
 * The ref a git source is fetched at when it names neither a `sha` nor a
 * `ref`: `HEAD`, the repository's default branch, as Claude Code resolves it.
 * Not `main`: the fetch honours the ref (DOR-2248), so a `main` default would
 * fail on every repository whose default branch is called something else.
 * Defined here and nowhere else: every resolver and the update check's commit
 * lookup take it from {@link sourceKeyOf}.
 */
const DEFAULT_REF = 'HEAD';

/**
 * The exact place a package is fetched from, normalized so two can be
 * compared. An install records it and the update check recomputes it; the
 * check may only trust "same commit, nothing changed" when both keys match.
 */
export interface SourceKey {
  /** The URL git is actually given. */
  cloneUrl: string;
  /** The package's directory inside the repository; `''` for a whole-repo source. */
  subpath: string;
  /** The effective ref: `sha ?? ref ?? 'HEAD'`. */
  ref: string;
}

/**
 * Normalize a resolved source into the {@link SourceKey} it is fetched from.
 * The single owner of the clone URL and the default ref: the fetch resolvers
 * take both from here rather than recomputing them, so an installed commit and
 * a looked-up commit always describe the same place.
 *
 * Typed so a git descriptor (`github`, `url`, `git-subdir`) always yields a
 * key: the fetch resolvers need no runtime assertion.
 *
 * @param source - A descriptor from {@link resolvePluginSource}.
 * @returns The key, or `undefined` for sources with no clone URL
 *   (`relative-path` over `file://`, `npm`).
 */
export function sourceKeyOf(source: GitSourceDescriptor): SourceKey;
export function sourceKeyOf(source: ResolvedSourceDescriptor): SourceKey | undefined;
export function sourceKeyOf(source: ResolvedSourceDescriptor): SourceKey | undefined {
  switch (source.type) {
    case 'github':
      return { cloneUrl: source.cloneUrl, subpath: '', ref: effectiveRef(source) };
    case 'url':
      return { cloneUrl: source.url, subpath: '', ref: effectiveRef(source) };
    case 'git-subdir':
      return { cloneUrl: source.cloneUrl, subpath: source.subpath, ref: effectiveRef(source) };
    case 'relative-path':
    case 'npm':
      return undefined;
  }
}

/** Pin precedence for a git source: `sha > ref > 'HEAD'`. */
function effectiveRef(source: { ref?: string; sha?: string }): string {
  return source.sha ?? source.ref ?? DEFAULT_REF;
}

/**
 * Error thrown when a source cannot be resolved (e.g., an absolute
 * `pluginRoot`, a path traversal, or a missing `marketplaceRoot` context
 * for a relative-path source).
 */
export class ResolvePluginSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolvePluginSourceError';
  }
}

/**
 * Resolution context. `marketplaceRoot` is required for relative-path
 * sources (absent for object-form sources). `pluginRoot` comes from
 * `metadata.pluginRoot` and is only consulted for bare relative-path
 * sources that do not already begin with `./`.
 */
export interface ResolveContext {
  marketplaceRoot?: string;
  pluginRoot?: string;
}

/**
 * Resolve a `PluginSource` value into a flat descriptor.
 *
 * **`metadata.pluginRoot` semantics** (applied only to relative-path
 * sources; object-form sources ignore `pluginRoot` entirely):
 *
 * 1. When `source` is a bare name (does not start with `./`) and
 *    `pluginRoot` is set: path = `<marketplaceRoot>/<pluginRoot>/<source>`.
 *    Example: `pluginRoot: './plugins'` + `source: 'code-reviewer'` →
 *    `<root>/plugins/code-reviewer`.
 * 2. When `source` already starts with `./`: path =
 *    `<marketplaceRoot>/<source>`. `pluginRoot` is ignored because the
 *    leading `./` is explicit.
 * 3. Trailing slashes on `pluginRoot` are normalized (stripped).
 * 4. Absolute paths (`/...`) in `pluginRoot` throw
 *    `ResolvePluginSourceError`.
 * 5. Relative paths containing `..` throw `ResolvePluginSourceError`.
 * 6. Object-form sources ignore `pluginRoot` entirely.
 *
 * @param source - The source value from a plugin entry.
 * @param context - Resolution context (marketplace root and pluginRoot).
 * @returns A resolved source descriptor.
 * @throws {ResolvePluginSourceError} when `pluginRoot` is absolute, contains
 *   `..`, or a relative-path source is supplied without `marketplaceRoot`.
 */
export function resolvePluginSource(
  source: PluginSource,
  context: ResolveContext
): ResolvedSourceDescriptor {
  if (typeof source === 'string') {
    return resolveRelativePath(source, context);
  }

  switch (source.source) {
    case 'github':
      return {
        type: 'github',
        repo: source.repo,
        ref: source.ref,
        sha: source.sha,
        cloneUrl: `https://github.com/${source.repo}.git`,
      };
    case 'url':
      return {
        type: 'url',
        url: source.url,
        ref: source.ref,
        sha: source.sha,
      };
    case 'git-subdir':
      return {
        type: 'git-subdir',
        cloneUrl: source.url,
        subpath: source.path,
        ref: source.ref,
        sha: source.sha,
      };
    case 'npm':
      return {
        type: 'npm',
        package: source.package,
        version: source.version,
        registry: source.registry,
      };
  }
}

/**
 * Resolve a relative-path (bare-string) source against the marketplace
 * root and optional pluginRoot. See `resolvePluginSource` for the full
 * rule set.
 */
function resolveRelativePath(source: string, context: ResolveContext): ResolvedSourceDescriptor {
  if (context.marketplaceRoot === undefined) {
    throw new ResolvePluginSourceError('relative-path source requires marketplaceRoot context');
  }
  if (source.includes('..')) {
    throw new ResolvePluginSourceError('Relative paths must not contain ".."');
  }

  const startsWithDotSlash = source.startsWith('./');
  let path: string;

  if (startsWithDotSlash) {
    // Explicit `./` prefix — ignore pluginRoot entirely.
    path = stripLeadingDotSlash(source);
  } else {
    // Bare name — optionally prepend pluginRoot.
    const pluginRoot = normalizePluginRoot(context.pluginRoot);
    path = pluginRoot ? `${pluginRoot}/${source}` : source;
  }

  return {
    type: 'relative-path',
    path,
    marketplaceRoot: context.marketplaceRoot,
  };
}

/**
 * Normalize a `metadata.pluginRoot` value: strip leading `./`, strip
 * trailing `/`, reject absolute paths. Returns an empty string when
 * `pluginRoot` is undefined or empty.
 */
function normalizePluginRoot(pluginRoot: string | undefined): string {
  if (!pluginRoot) return '';
  if (pluginRoot.startsWith('/')) {
    throw new ResolvePluginSourceError(`pluginRoot must be relative, got absolute: ${pluginRoot}`);
  }
  if (pluginRoot.includes('..')) {
    throw new ResolvePluginSourceError('pluginRoot must not contain ".."');
  }
  // The lookbehind pins the attempt to the START of the trailing slash run,
  // which is where the leftmost match already began — same result, without
  // retrying at every offset of the run. `pluginRoot` comes out of a manifest
  // fetched from whatever marketplace the operator added, and the guards above
  // check its shape but never its length (CodeQL js/polynomial-redos).
  return stripLeadingDotSlash(pluginRoot).replace(/(?<!\/)\/+$/, '');
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}
