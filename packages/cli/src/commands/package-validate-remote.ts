/**
 * CLI handler for `dorkos package validate-remote <marketplace-url>`.
 *
 * Fetches `.claude-plugin/marketplace.json` and the optional sibling
 * `.claude-plugin/dorkos.json` sidecar from a remote marketplace repo
 * (usually `https://github.com/<owner>/<repo>` for GitHub-hosted
 * marketplaces, or a direct raw URL), then runs the same DorkOS +
 * strict-CC validation pipeline as the local `validate-marketplace`
 * command. No clone, no temp directory, no git dependency.
 *
 * Used by the `dork-labs/marketplace` GitHub Actions workflow to verify
 * that every referenced marketplace URL still serves a valid
 * `marketplace.json` before merging catalog changes.
 *
 * Exit codes:
 *
 * - `0` — marketplace.json (and sidecar, if present) pass both schemas
 * - `1` — fetch failed / DorkOS schema failed / sidecar invalid / reserved name
 * - `2` — DorkOS schema passes but strict CC validation fails
 *
 * @module commands/package-validate-remote
 */
import {
  parseMarketplaceJson,
  parseDorkosSidecar,
  validateAgainstCcSchema,
  RESERVED_MARKETPLACE_NAMES,
} from '@dorkos/marketplace';
import {
  checkSourcePaths,
  makeRemoteCandidateBuilder,
  remoteProbe,
  renderSourcePathResults,
} from './validate-source-paths.js';

/** Parsed CLI arguments accepted by {@link runValidateRemote}. */
export interface ValidateRemoteArgs {
  /** Remote marketplace URL. Accepts either a GitHub repo URL or a raw
   *  `.claude-plugin/marketplace.json` URL. */
  url: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos package validate-remote <marketplace-url>';

/**
 * Parse the raw argv slice that follows `dorkos package validate-remote`.
 *
 * Strict-positional only — no flags are accepted today. Throws an `Error`
 * (caught and formatted by the CLI dispatcher) when the positional URL is
 * missing.
 *
 * @param rawArgs - The argv slice after `package validate-remote`.
 * @returns A typed {@link ValidateRemoteArgs} object.
 */
export function parseValidateRemoteArgs(rawArgs: string[]): ValidateRemoteArgs {
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) {
    throw new Error(`Missing required <marketplace-url> argument.\n${USAGE_LINE}`);
  }
  return { url: positional[0] };
}

/**
 * Implements `dorkos package validate-remote <url>`.
 *
 * Performs, in order:
 * 1. Resolve the `marketplace.json` and `dorkos.json` URLs from the input.
 * 2. Fetch both in parallel. Sidecar 404 is non-fatal.
 * 3. Run the DorkOS passthrough parse. Exit 1 on failure.
 * 4. Parse the sidecar (if fetched). Exit 1 on parse error.
 * 5. Run the strict CC compatibility second pass. Exit 2 on failure.
 * 6. Check the marketplace name against the reserved list.
 * 7. Print the summary to stdout and exit 0.
 *
 * @param args - Parsed CLI arguments.
 * @returns The intended process exit code.
 */
export async function runValidateRemote(args: ValidateRemoteArgs): Promise<number> {
  const marketplaceUrl = resolveMarketplaceJsonUrl(args.url);
  const sidecarUrl = resolveDorkosSidecarUrl(args.url);

  let marketplaceRaw: string;
  try {
    const res = await fetch(marketplaceUrl);
    if (!res.ok) {
      process.stderr.write(
        `[FAIL] Fetch marketplace.json\n  - ${marketplaceUrl}: ${res.status} ${res.statusText}\n`
      );
      return 1;
    }
    marketplaceRaw = await res.text();
  } catch (err) {
    process.stderr.write(
      `[FAIL] Fetch marketplace.json\n  - ${marketplaceUrl}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
  process.stdout.write(`[OK]   Fetched ${marketplaceUrl}\n`);

  // Sidecar fetch in parallel is unnecessary since we already awaited the
  // marketplace fetch above; attempt it here (non-fatal) so the CLI doesn't
  // need a second round-trip when the marketplace fails.
  let sidecarRaw: string | null = null;
  try {
    const res = await fetch(sidecarUrl);
    if (res.ok) {
      sidecarRaw = await res.text();
    }
  } catch {
    // Non-fatal — sidecar is always optional.
  }

  // 1. DorkOS passthrough schema.
  const dorkosResult = parseMarketplaceJson(marketplaceRaw);
  if (!dorkosResult.ok) {
    process.stderr.write(`[FAIL] DorkOS schema\n  - ${dorkosResult.error}\n`);
    return 1;
  }
  process.stdout.write(`[OK]   DorkOS schema (passthrough)\n`);

  // 2. Optional sidecar parse.
  let sidecarCount: number | 'absent' = 'absent';
  if (sidecarRaw !== null) {
    const sidecarResult = parseDorkosSidecar(sidecarRaw);
    if (!sidecarResult.ok) {
      process.stderr.write(`[FAIL] Sidecar dorkos.json\n  - ${sidecarResult.error}\n`);
      return 1;
    }
    sidecarCount = Object.keys(sidecarResult.sidecar.plugins).length;
    process.stdout.write(`[OK]   Sidecar present and valid (${sidecarCount} plugins)\n`);
  } else {
    process.stdout.write(`[OK]   Sidecar absent (optional)\n`);
  }

  // 3. Strict CC compatibility.
  const ccResult = validateAgainstCcSchema(JSON.parse(marketplaceRaw));
  if (!ccResult.ok) {
    process.stderr.write(`[FAIL] Claude Code compatibility (strict)\n`);
    for (const issue of ccResult.errors) {
      const where = issue.path.join('.') || '<root>';
      process.stderr.write(`  - ${where}: ${issue.message}\n`);
    }
    return 2;
  }
  process.stdout.write(`[OK]   Claude Code compatibility (strict)\n`);

  // 4. Reachability check for relative-path sources. Issues a parallel
  //    GET for each resolved `<rawBase>/<resolved>/.claude-plugin/plugin.json`
  //    so the CI gate catches broken paths before publish. Object-form
  //    sources (`github`, `url`, `git-subdir`, `npm`) are skipped to
  //    avoid introducing network dependencies on external git hosts.
  const rawBase = resolveRawBaseUrl(marketplaceUrl);
  const sourcePathReport = await checkSourcePaths(
    dorkosResult.marketplace,
    remoteProbe,
    makeRemoteCandidateBuilder(rawBase),
    rawBase
  );
  const sourceRendered = renderSourcePathResults(sourcePathReport, dorkosResult.marketplace);
  if (!sourcePathReport.ok) {
    process.stderr.write(sourceRendered.failBlock);
    return 2;
  }
  process.stdout.write(sourceRendered.okLine);

  // 5. Reserved-name enforcement (already caught by the DorkOS schema,
  //    surfaced explicitly for a clearer error message).
  if (RESERVED_MARKETPLACE_NAMES.has(dorkosResult.marketplace.name)) {
    process.stderr.write(`[FAIL] Marketplace name reserved: "${dorkosResult.marketplace.name}"\n`);
    return 1;
  }
  process.stdout.write(`[OK]   Marketplace name not reserved\n`);

  process.stdout.write(
    `\nAll checks passed. ${args.url} (${dorkosResult.marketplace.plugins.length} packages)\n`
  );
  return 0;
}

/**
 * Resolve a remote marketplace URL into the canonical raw
 * `marketplace.json` URL. Mirrors the server-side helper of the same name
 * in `apps/server/src/services/marketplace/package-fetcher.ts`.
 *
 * @internal Exported for testing.
 */
export function resolveMarketplaceJsonUrl(input: string): string {
  if (input.endsWith('.claude-plugin/marketplace.json')) return input;
  if (input.endsWith('marketplace.json')) return input;
  const base = input.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/.claude-plugin/marketplace.json`;
}

/**
 * Resolve a remote marketplace URL into the canonical raw `dorkos.json`
 * sidecar URL.
 *
 * @internal Exported for testing.
 */
export function resolveDorkosSidecarUrl(input: string): string {
  if (input.endsWith('.claude-plugin/dorkos.json')) return input;
  const base = input.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/.claude-plugin/dorkos.json`;
}

/**
 * Given the canonical raw `marketplace.json` URL returned by
 * {@link resolveMarketplaceJsonUrl}, strip the trailing
 * `/.claude-plugin/marketplace.json` to produce the raw base URL that
 * sibling files (plugin manifests, READMEs) are resolved against.
 *
 * @internal Exported for testing.
 */
export function resolveRawBaseUrl(marketplaceJsonUrl: string): string {
  return marketplaceJsonUrl.replace(/\/?\.claude-plugin\/marketplace\.json$/, '');
}
