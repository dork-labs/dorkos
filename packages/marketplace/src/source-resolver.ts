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
  return stripLeadingDotSlash(pluginRoot).replace(/\/+$/, '');
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}
