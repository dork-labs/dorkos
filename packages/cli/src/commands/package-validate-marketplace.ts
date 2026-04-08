/**
 * CLI handler for `dorkos package validate-marketplace <path>`.
 *
 * Validates a `marketplace.json` file against both the DorkOS
 * passthrough schema and the strict CC compatibility oracle
 * (`cc-validator.ts`). If a sibling `dorkos.json` sidecar exists next to
 * the target file (i.e. both live under `.claude-plugin/`), it is also
 * parsed so authors can verify the full DorkOS + CC surface in a single
 * command.
 *
 * Used by the `dork-labs/marketplace` GitHub Actions workflow on every
 * PR to gate registry submissions. Returns the intended exit code rather
 * than calling `process.exit` so the top-level dispatcher in `cli.ts`
 * retains the single source of truth for process termination.
 *
 * Exit codes:
 *
 * - `0` — file is valid against both schemas
 * - `1` — file missing / unreadable / DorkOS schema validation failed /
 *         sidecar present but invalid / marketplace name reserved
 * - `2` — DorkOS schema passes but CC strict validation fails (outbound
 *         compatibility regression)
 *
 * @module commands/package-validate-marketplace
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseMarketplaceJson,
  parseDorkosSidecar,
  validateAgainstCcSchema,
  RESERVED_MARKETPLACE_NAMES,
} from '@dorkos/marketplace';
import {
  checkSourcePaths,
  localProbe,
  makeLocalCandidateBuilder,
  renderSourcePathResults,
} from './validate-source-paths.js';

/** Parsed CLI arguments accepted by {@link runValidateMarketplace}. */
export interface ValidateMarketplaceArgs {
  /** Filesystem path (absolute or relative to `process.cwd()`) of the marketplace.json to validate. */
  path: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos package validate-marketplace <path>';

/**
 * Parse the raw argv slice that follows `dorkos package validate-marketplace`.
 *
 * Strict-positional only — no flags are accepted today. Throws an `Error`
 * (caught and formatted by the CLI dispatcher) when the positional path is
 * missing.
 *
 * @param rawArgs - The argv slice after `package validate-marketplace`.
 * @returns A typed {@link ValidateMarketplaceArgs} object.
 */
export function parseValidateMarketplaceArgs(rawArgs: string[]): ValidateMarketplaceArgs {
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) {
    throw new Error(`Missing required <path> argument.\n${USAGE_LINE}`);
  }
  return { path: positional[0] };
}

/**
 * Implements `dorkos package validate-marketplace <path>`.
 *
 * Performs, in order:
 * 1. Read the file at `args.path`.
 * 2. Parse with the DorkOS passthrough schema. Exit 1 on failure.
 * 3. If the path is `.../.claude-plugin/marketplace.json`, attempt to
 *    read `.../.claude-plugin/dorkos.json` as a sidecar. Missing sidecar
 *    is non-fatal; parse errors exit 1.
 * 4. Run the strict CC-compatibility second pass. Exit 2 on failure.
 * 5. Probe every relative-path plugin source for reachability (does
 *    `<marketplaceRoot>/<resolved>/.claude-plugin/plugin.json` exist?).
 *    Exit 2 when any source would fail at `claude plugin install` time.
 * 6. Check the marketplace name against the reserved list. Exit 1 on hit.
 * 7. Print the summary to stdout and exit 0.
 *
 * @param args - Parsed CLI arguments.
 * @returns The intended process exit code.
 */
export async function runValidateMarketplace(args: ValidateMarketplaceArgs): Promise<number> {
  const absPath = path.resolve(process.cwd(), args.path);

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    process.stderr.write(`Failed to read ${absPath}: ${(err as Error).message}\n`);
    return 1;
  }

  // 1. DorkOS schema (passthrough) — this is what `@dorkos/marketplace`
  //    actually reads at runtime.
  const dorkosResult = parseMarketplaceJson(content);
  if (!dorkosResult.ok) {
    process.stderr.write(`[FAIL] DorkOS schema\n  - ${dorkosResult.error}\n`);
    return 1;
  }
  process.stdout.write(`[OK]   DorkOS schema (passthrough)\n`);

  // 2. Optional sidecar, only when the target lives under .claude-plugin/.
  let sidecarCount: number | 'absent' | 'invalid' = 'absent';
  if (path.basename(path.dirname(absPath)) === '.claude-plugin') {
    const sidecarPath = path.join(path.dirname(absPath), 'dorkos.json');
    try {
      const sidecarRaw = await fs.readFile(sidecarPath, 'utf8');
      const sidecarResult = parseDorkosSidecar(sidecarRaw);
      if (!sidecarResult.ok) {
        process.stderr.write(`[FAIL] Sidecar dorkos.json\n  - ${sidecarResult.error}\n`);
        return 1;
      }
      sidecarCount = Object.keys(sidecarResult.sidecar.plugins).length;
      process.stdout.write(`[OK]   Sidecar present and valid (${sidecarCount} plugins)\n`);
    } catch {
      process.stdout.write(`[OK]   Sidecar absent (optional)\n`);
    }
  } else {
    process.stdout.write(`[OK]   Sidecar not applicable (not under .claude-plugin/)\n`);
  }

  // 3. Strict CC compatibility — the outbound invariant oracle.
  const ccResult = validateAgainstCcSchema(JSON.parse(content));
  if (!ccResult.ok) {
    process.stderr.write(`[FAIL] Claude Code compatibility (strict)\n`);
    for (const issue of ccResult.errors) {
      const where = issue.path.join('.') || '<root>';
      process.stderr.write(`  - ${where}: ${issue.message}\n`);
    }
    process.stderr.write(
      `\nDorkOS extensions (type, layers, icon, etc.) must live in .claude-plugin/dorkos.json, not inline.\n`
    );
    return 2;
  }
  process.stdout.write(`[OK]   Claude Code compatibility (strict)\n`);

  // 4. Reachability check for relative-path sources. Schema shape alone
  //    can't catch the case where `./<name>` + pluginRoot resolves to a
  //    directory that doesn't exist on disk (CC 2.1.92 ignores
  //    pluginRoot when the source has an explicit `./` prefix). This
  //    catches the regression at validate time instead of at
  //    `claude plugin install` time.
  const marketplaceRoot =
    path.basename(path.dirname(absPath)) === '.claude-plugin'
      ? path.dirname(path.dirname(absPath))
      : path.dirname(absPath);
  const sourcePathReport = await checkSourcePaths(
    dorkosResult.marketplace,
    localProbe,
    makeLocalCandidateBuilder(marketplaceRoot),
    marketplaceRoot
  );
  const sourceRendered = renderSourcePathResults(sourcePathReport, dorkosResult.marketplace);
  if (!sourcePathReport.ok) {
    process.stderr.write(sourceRendered.failBlock);
    return 2;
  }
  process.stdout.write(sourceRendered.okLine);

  // 5. Reserved-name enforcement — already caught by the DorkOS schema
  //    but we surface it explicitly for a clearer error message.
  if (RESERVED_MARKETPLACE_NAMES.has(dorkosResult.marketplace.name)) {
    process.stderr.write(`[FAIL] Marketplace name reserved: "${dorkosResult.marketplace.name}"\n`);
    return 1;
  }
  process.stdout.write(`[OK]   Marketplace name not reserved\n`);

  process.stdout.write(
    `\nAll checks passed. ${absPath} (${dorkosResult.marketplace.plugins.length} packages)\n`
  );
  return 0;
}
