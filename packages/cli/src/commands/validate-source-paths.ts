/**
 * Post-schema "can it actually install" reachability check.
 *
 * After schema shape is validated by the DorkOS passthrough and strict
 * Claude Code passes, this module verifies that every relative-path
 * plugin entry resolves to a real, reachable `.claude-plugin/plugin.json`
 * — matching CC 2.1.92's install-time path resolution exactly via
 * `resolvePluginSource`.
 *
 * This is the load-bearing check that prevents the following class of
 * bug: a registry that passes `marketplace.json` schema (both DorkOS and
 * strict CC) but whose `source: "./<name>"` entries point nowhere on
 * disk because `metadata.pluginRoot` is silently ignored when the source
 * has an explicit `./` prefix. CC exits with "Source path does not
 * exist" at install time; this check catches the regression before
 * publish.
 *
 * Object-form sources (`github`, `url`, `git-subdir`, `npm`) are not
 * probed — CC clones them at install time and validation should not
 * introduce unreliable network dependencies on external git hosts.
 *
 * @module commands/validate-source-paths
 */

import path from 'node:path';
import { resolvePluginSource, type MarketplaceJson } from '@dorkos/marketplace';

/** Per-entry reachability result. */
export type SourcePathCheckResult =
  | { name: string; status: 'ok'; candidate: string }
  | { name: string; status: 'not-found'; candidate: string; sourceInput: string }
  | { name: string; status: 'skipped-object-source' };

/** Aggregate report returned by {@link checkSourcePaths}. */
export interface SourcePathCheckReport {
  /** `true` when every checked entry passed (skipped entries do not affect this). */
  ok: boolean;
  /** Per-entry results in `marketplace.plugins` order. */
  results: SourcePathCheckResult[];
  /** Number of entries actually probed (excludes skipped object-form sources). */
  checkedCount: number;
  /** Total number of entries in the marketplace. */
  totalCount: number;
}

/**
 * Probe function: returns `true` when the given candidate (an absolute
 * filesystem path or a fully-qualified URL) is reachable. Callers inject
 * the appropriate implementation — {@link localProbe} for filesystem
 * validation, {@link remoteProbe} for URL validation.
 */
export type SourcePathProbe = (candidate: string) => Promise<boolean>;

/**
 * Builder that turns a resolved relative-path source (e.g.
 * `plugins/code-reviewer`) into the concrete probe target (an absolute
 * path or URL pointing at the plugin's `.claude-plugin/plugin.json`).
 */
export type ProbeCandidateBuilder = (resolvedRelativePath: string) => string;

/**
 * For each plugin entry with a relative-path source, resolve via
 * `resolvePluginSource` (which encodes CC 2.1.92's pluginRoot rules),
 * build the probe candidate, and call `probe`. Probes run in parallel
 * via `Promise.all`.
 *
 * Object-form sources (`github`, `url`, `git-subdir`, `npm`) are
 * recorded as `skipped-object-source` and do not affect `ok`.
 *
 * @param marketplace - The parsed DorkOS-schema marketplace object.
 * @param probe - Reachability probe injected by the caller.
 * @param buildCandidate - Candidate builder injected by the caller.
 * @param marketplaceRoot - The root used to resolve relative sources.
 *   Required by `resolvePluginSource`; stored in the descriptor but not
 *   used by `buildCandidate` (the builder owns the final path layout).
 */
export async function checkSourcePaths(
  marketplace: MarketplaceJson,
  probe: SourcePathProbe,
  buildCandidate: ProbeCandidateBuilder,
  marketplaceRoot: string
): Promise<SourcePathCheckReport> {
  const tasks = marketplace.plugins.map(async (entry): Promise<SourcePathCheckResult> => {
    if (typeof entry.source !== 'string') {
      return { name: entry.name, status: 'skipped-object-source' };
    }
    const sourceInput = entry.source;
    const resolved = resolvePluginSource(sourceInput, {
      marketplaceRoot,
      pluginRoot: marketplace.metadata?.pluginRoot,
    });
    // Narrow defensively — the typeof check above guarantees 'relative-path'.
    if (resolved.type !== 'relative-path') {
      return { name: entry.name, status: 'skipped-object-source' };
    }
    const candidate = buildCandidate(resolved.path);
    const reachable = await probe(candidate);
    return reachable
      ? { name: entry.name, status: 'ok', candidate }
      : { name: entry.name, status: 'not-found', candidate, sourceInput };
  });

  const results = await Promise.all(tasks);
  const checkedCount = results.filter((r) => r.status !== 'skipped-object-source').length;
  const ok = results.every((r) => r.status !== 'not-found');
  return { ok, results, checkedCount, totalCount: marketplace.plugins.length };
}

/**
 * Build a candidate builder for local-filesystem probing. The returned
 * function joins `<marketplaceRoot>/<resolvedPath>/.claude-plugin/plugin.json`.
 */
export function makeLocalCandidateBuilder(marketplaceRoot: string): ProbeCandidateBuilder {
  return (resolvedPath) =>
    path.join(marketplaceRoot, resolvedPath, '.claude-plugin', 'plugin.json');
}

/**
 * Build a candidate builder for remote HTTP probing against a raw base
 * URL. `rawBase` should have the shape
 * `https://<host>/<owner>/<repo>/raw/<ref>` (no trailing slash required
 * — the builder normalizes it).
 */
export function makeRemoteCandidateBuilder(rawBase: string): ProbeCandidateBuilder {
  const normalized = rawBase.replace(/\/+$/, '');
  return (resolvedPath) => `${normalized}/${resolvedPath}/.claude-plugin/plugin.json`;
}

/** Local-filesystem probe backed by `fs.stat`. */
export async function localProbe(candidate: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    const s = await stat(candidate);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Remote HTTP probe that issues a `GET` to the candidate URL and
 * returns `true` on any 2xx response. `GET` is used instead of `HEAD`
 * because GitHub's raw URL handler is inconsistent on `HEAD`.
 */
export async function remoteProbe(candidate: string): Promise<boolean> {
  try {
    const res = await fetch(candidate);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Render a {@link SourcePathCheckReport} into CLI output blocks.
 *
 * On success: a single `[OK]` line.
 *
 * On failure: a `[FAIL]` line plus per-entry detail lines. When
 * `metadata.pluginRoot` is set AND at least one failing source started
 * with an explicit `./`, a targeted hint is appended pointing at the
 * specific pluginRoot-is-ignored regression.
 *
 * @returns Two strings. Exactly one is non-empty depending on `report.ok`.
 */
export function renderSourcePathResults(
  report: SourcePathCheckReport,
  marketplace: MarketplaceJson
): { okLine: string; failBlock: string } {
  const { results, checkedCount, totalCount } = report;
  const skippedCount = totalCount - checkedCount;
  const okCount = results.filter((r) => r.status === 'ok').length;

  if (report.ok) {
    let suffix: string;
    if (checkedCount === 0) {
      suffix = ' (no relative-path sources to verify)';
    } else if (skippedCount > 0) {
      suffix = ` (${okCount}/${checkedCount} relative-path, ${skippedCount} object-form skipped)`;
    } else {
      suffix = ` (${okCount}/${checkedCount})`;
    }
    return { okLine: `[OK]   Plugin sources reachable${suffix}\n`, failBlock: '' };
  }

  const lines: string[] = [`[FAIL] Plugin sources reachable (${okCount}/${checkedCount})\n`];
  for (const r of results) {
    if (r.status !== 'not-found') continue;
    lines.push(`  - ${r.name}: "${r.sourceInput}" → not found at ${r.candidate}\n`);
  }

  const pluginRoot = marketplace.metadata?.pluginRoot;
  const failingWithExplicitDotSlash = results.some(
    (r) => r.status === 'not-found' && r.sourceInput.startsWith('./')
  );

  if (pluginRoot !== undefined && failingWithExplicitDotSlash) {
    const normalizedRoot = pluginRoot.replace(/^\.\//, '').replace(/\/+$/, '');
    lines.push(
      '\n' +
        `  Hint: metadata.pluginRoot is "${pluginRoot}" but CC 2.1.92 IGNORES pluginRoot\n` +
        `  when a source starts with an explicit "./". Rewrite each affected entry as\n` +
        `  "./${normalizedRoot}/<name>" so the full path is explicit.\n`
    );
  }

  return { okLine: '', failBlock: lines.join('') };
}
