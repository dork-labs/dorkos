/**
 * The dot-path walk and matcher every "may this caller write this field" guard
 * on the operator surface shares.
 *
 * Two tables ask that question about different things — `config-write-policy.ts`
 * about `UserConfigSchema`, `agent-write-policy.ts` about an agent's own manifest
 * — and both answer it the same way: classify each leaf by dot-path, walk what
 * the caller actually sent, and refuse the whole patch when the two meet. The
 * walk is subtle enough that having two copies of it is how one of them quietly
 * stops covering part of its table (DOR-1113, recorded on {@link patchPaths}), so
 * it lives here once.
 *
 * This module knows nothing about either table. It takes a list of guarded
 * dot-paths and a patch, and says which of the paths the patch reaches.
 *
 * @module services/core/operator/guarded-paths
 */

/**
 * Every dot-path a patch object touches, including a path that ends at an empty
 * object or an empty array, and including the fields inside a LIST it writes.
 *
 * Deliberately not `flattenConfigKeys` (which drops `{ auth: {} }` entirely): a
 * guard should see every branch the caller reached for, not only the ones that
 * carry a value.
 *
 * ## Why it descends into arrays (DOR-1113)
 *
 * A policy table classifies a list's fields one per element — the `[]`
 * convention `CONFIG_DISCLOSURE` uses — so `connectors.rawMcpServers[].url` is
 * the only key that exists for a raw-MCP server's URL. A walk that stopped at
 * the array reported `connectors.rawMcpServers`, which equals no policy key and
 * is a prefix of none either, because the `[]` sits between them.
 *
 * Removing that marker at match time ({@link withoutArrayMarkers}) is what closes
 * the hole; this descent is what makes the refusal HONEST. Without it the whole
 * list is one opaque path, so every element field is named whatever the caller
 * wrote — a patch touching only `url` would be refused in the name of `slug`,
 * `displayName` and `transport` too, and the refusal text lands in a model's
 * context as a claim about what it just tried to do (DOR-1044).
 *
 * So an array is a segment, not a leaf: its elements are walked under a `[]`
 * marker. An EMPTY array carries no element to descend into and stays a leaf —
 * caught as an ancestor of the element fields, the way `{ auth: {} }` is, because
 * emptying a list is a write to it.
 *
 * A top-level array is not a patch at all (`applyConfigPatch` rejects the shape,
 * and so does every manifest write surface), and touching nothing is the honest
 * answer for it.
 *
 * @param value - The patch node being walked.
 * @param prefix - Internal accumulator for the current path; omit at call sites.
 * @returns Dot-paths for every leaf and every empty branch, `[]` marking each
 *   descent through array elements.
 */
export function patchPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    if (!prefix) return [];
    if (value.length === 0) return [prefix];
    return value.flatMap((element) => patchPaths(element, `${prefix}[]`));
  }
  if (value === null || typeof value !== 'object') {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, child]) => patchPaths(child, prefix ? `${prefix}.${key}` : key));
}

/**
 * Drop the `[]` array markers from a dot-path, leaving the plain segment chain
 * both sides of a match are compared on.
 *
 * Comparing without the marker is what lets one policy key cover both shapes a
 * caller can use: `{ rawMcpServers: [{ url }] }` reaches the field through an
 * element, `{ rawMcpServers: [] }` and `{ connectors: {} }` stop above it, and
 * all three have to hit `connectors.rawMcpServers[].url`. It cannot merge two
 * distinct policy keys into one, because a field is either an array of objects
 * or an object, never both — pinned by a test that strips a whole table and
 * asserts the result still has no duplicates.
 *
 * @param path - A dot-path, with or without `[]` segments.
 * @returns The same path with every `[]` removed.
 */
export function withoutArrayMarkers(path: string): string {
  return path.replaceAll('[]', '');
}

/** One guarded policy path, paired with the marker-stripped form it matches on. */
export interface GuardedPath {
  /** The policy key itself, `[]` markers intact — what a refusal names. */
  readonly path: string;
  /** The same key with its `[]` markers removed — what the comparison uses. */
  readonly plain: string;
}

/**
 * Pair each guarded path with its marker-stripped form, once.
 *
 * Called at module scope by each table rather than per request: they are
 * constants, `PATCH /api/config` runs the matcher twice on every call, and
 * re-deriving 60-odd strings each time buys nothing.
 *
 * @param paths - A guarded policy path list.
 * @returns The same paths, each carrying its plain form.
 */
export function prepareGuardedPaths(paths: readonly string[]): readonly GuardedPath[] {
  return paths.map((path) => ({ path, plain: withoutArrayMarkers(path) }));
}

/**
 * Find which of a guarded set of dot-paths a patch tries to write.
 *
 * Matching runs in both directions along the dot-path, so neither a deeper nor a
 * shallower patch slips past: `{ auth: { enabled: false } }` hits `auth.enabled`
 * exactly, `{ auth: true }` hits it as an ancestor, and
 * `{ providers: { anthropic: '…' } }` hits the `providers` record as a descendant.
 *
 * Both sides are compared with their `[]` markers removed, so a field inside a
 * list matches however the caller reached it (see {@link withoutArrayMarkers}).
 * The RETURNED paths are the policy keys themselves, markers intact, because
 * they are what a refusal names and what each table's stake groups are keyed on.
 *
 * ## The touched paths are DEDUPED first, and that is not a micro-optimization
 *
 * Descending into arrays makes the walk's output scale with element COUNT, not
 * with the number of distinct settings: a 1MB patch holding one long list emits
 * hundreds of thousands of identical strings, and each one was matched against
 * every guarded path. That is over a SECOND of blocked event loop for a single
 * request (measured against the config table at 2174ms on a flat list, 1160ms on
 * a nested one, both ~1MB) — and `PATCH /api/config` runs this BEFORE any
 * authority check, so in the login-off posture anything that can reach the port
 * can spend it. Deduping first took the same payloads to 201ms and 236ms.
 *
 * It cannot change a verdict: a repeated path can only re-add hits already in
 * the set.
 *
 * @param touched - The dot-paths a patch reaches, `[]` markers already removed.
 *   Deduped here, so a caller may hand over the walk's raw output.
 * @param guarded - The prepared policy paths to match against.
 * @returns The offending policy paths, sorted, each named once.
 */
export function matchGuardedPaths(
  touched: Iterable<string>,
  guarded: readonly GuardedPath[]
): string[] {
  const hits = new Set<string>();

  for (const path of new Set(touched)) {
    for (const { path: guardedPath, plain } of guarded) {
      if (path === plain || path.startsWith(`${plain}.`) || plain.startsWith(`${path}.`)) {
        hits.add(guardedPath);
      }
    }
  }

  return [...hits].sort();
}

/**
 * Find which of a guarded set of dot-paths a patch tries to write.
 *
 * The walk and the match, together: {@link patchPaths} for what the caller
 * reached, {@link matchGuardedPaths} for which policy keys that meets. A guard
 * whose seam needs to ADD to the walk's output — because its write semantics
 * touch more than the caller named — composes the two itself rather than
 * changing what the walk emits for everybody (`agent-write-policy.ts` does).
 *
 * @param patch - The raw patch a caller supplied.
 * @param guarded - The prepared policy paths to match against.
 * @returns The offending policy paths, sorted, each named once.
 */
export function findGuardedPaths(patch: unknown, guarded: readonly GuardedPath[]): string[] {
  return matchGuardedPaths(patchPaths(patch).map(withoutArrayMarkers), guarded);
}
