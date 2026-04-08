/**
 * CLI handler for `dorkos marketplace validate <path-or-url>`.
 *
 * Single entry point for validating a marketplace registry against both
 * the DorkOS passthrough schema and the strict Claude Code compatibility
 * oracle (`cc-validator.ts`). Auto-detects whether the positional
 * argument is a local filesystem path or an HTTP(S) URL, and delegates
 * to the underlying handlers:
 *
 * - URL (starts with `http://` / `https://`) → fetches
 *   `.claude-plugin/marketplace.json` and the optional
 *   `.claude-plugin/dorkos.json` sidecar from the remote repo and runs
 *   the full validation pipeline. No clone, no temp directory, no git
 *   dependency. GitHub-hosted marketplaces resolve to the `main` branch;
 *   direct raw URLs are passed through unchanged. See
 *   {@link ./package-validate-remote.runValidateRemote}.
 * - Path (anything else) → reads the file at `args.target`, and, when
 *   the file lives under `.claude-plugin/`, also reads the sibling
 *   `dorkos.json` sidecar. See
 *   {@link ./package-validate-marketplace.runValidateMarketplace}.
 *
 * This command replaces the legacy `dorkos package validate-marketplace`
 * and `dorkos package validate-remote` aliases, which remain functional
 * for one release with a stderr deprecation notice.
 *
 * Exit codes (forwarded from the delegated handler):
 *
 * - `0` — marketplace.json (and sidecar, if present) pass both schemas
 * - `1` — fetch/read failed / DorkOS schema failed / sidecar invalid / reserved name
 * - `2` — DorkOS schema passes but strict CC validation fails
 *
 * @module commands/marketplace-validate
 */
import { runValidateMarketplace } from './package-validate-marketplace.js';
import { runValidateRemote } from './package-validate-remote.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceValidate}. */
export interface MarketplaceValidateArgs {
  /** Filesystem path or HTTP(S) URL to a marketplace registry. */
  target: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace validate <path-or-url>';

/**
 * Detect whether a positional argument is an HTTP(S) URL.
 *
 * Intentionally narrow — we only accept `http://` and `https://` so local
 * paths containing the substring `http` (e.g. `./fixtures/http-test.json`)
 * aren't misrouted to the remote fetch path.
 *
 * @internal Exported for testing.
 */
export function isRemoteTarget(target: string): boolean {
  return target.startsWith('http://') || target.startsWith('https://');
}

/**
 * Parse the raw argv slice that follows `dorkos marketplace validate`.
 *
 * Strict-positional only — no flags are accepted today. Throws an `Error`
 * (caught and formatted by the marketplace dispatcher) when the positional
 * argument is missing.
 *
 * @param rawArgs - The argv slice after `marketplace validate`.
 * @returns A typed {@link MarketplaceValidateArgs} object.
 */
export function parseMarketplaceValidateArgs(rawArgs: string[]): MarketplaceValidateArgs {
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) {
    throw new Error(`Missing required <path-or-url> argument.\n${USAGE_LINE}`);
  }
  return { target: positional[0] };
}

/**
 * Implements `dorkos marketplace validate <path-or-url>`.
 *
 * Auto-detects the target shape and delegates to the matching underlying
 * handler. Exit code semantics are forwarded unchanged from the delegate
 * so callers can rely on a single, stable contract regardless of input
 * shape.
 *
 * @param args - Parsed CLI arguments.
 * @returns The intended process exit code.
 */
export async function runMarketplaceValidate(args: MarketplaceValidateArgs): Promise<number> {
  if (isRemoteTarget(args.target)) {
    return runValidateRemote({ url: args.target });
  }
  return runValidateMarketplace({ path: args.target });
}
