/**
 * CLI handler for `dorkos marketplace held-back` (DOR-2306).
 *
 * A globally installed package that runs things on its own (commands, servers,
 * programs) loads into every session only once you approved it exactly as it
 * is. Until then DorkOS holds it back. This command:
 *
 * - lists every held-back package, why, and what to do (no flags);
 * - `--allow <name>` prints everything it runs, asks (skip with `--yes`), and
 *   records your yes, bound to the files it just showed you;
 * - `--refuse <name>` records your no the same way.
 *
 * Deciding is yours: the server refuses a decision from an agent. A package
 * that runs too much to show on one approval card can still be reviewed here,
 * because a terminal can print the whole list. One that DorkOS could not read
 * cannot be approved anywhere; the listing says what to do instead.
 *
 * @module commands/marketplace-held-back
 */
import { parseArgs } from 'node:util';
import type { HeldBackPackage } from '@dorkos/shared/marketplace-schemas';
import { ApiError, apiCall } from '../lib/api-client.js';
import { confirm } from '../lib/confirm-prompt.js';
import { renderDisclosureLines } from '../lib/disclosure-render.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceHeldBack}. */
export interface MarketplaceHeldBackArgs {
  /** Record a yes for this package. */
  allow?: string;
  /** Record a no for this package. */
  refuse?: string;
  /** Do not ask before recording a yes (it still prints what runs). */
  yes?: boolean;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace held-back [--allow <name> [--yes] | --refuse <name>]';

/**
 * Parse the argv slice that follows `dorkos marketplace held-back`.
 *
 * @param rawArgs - The argv slice after `held-back`.
 * @returns A typed {@link MarketplaceHeldBackArgs}.
 */
export function parseMarketplaceHeldBackArgs(rawArgs: string[]): MarketplaceHeldBackArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        allow: { type: 'string' },
        refuse: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace held-back', USAGE_LINE);
  }
  const { values } = parsed;
  if (values.allow !== undefined && values.refuse !== undefined) {
    throw new Error(`Pass --allow or --refuse, not both.\n${USAGE_LINE}`);
  }
  return {
    ...(typeof values.allow === 'string' && { allow: values.allow }),
    ...(typeof values.refuse === 'string' && { refuse: values.refuse }),
    yes: Boolean(values.yes),
  };
}

/** Every held-back package the running DorkOS reports. */
async function fetchHeldBack(): Promise<HeldBackPackage[]> {
  return (await apiCall<{ packages: HeldBackPackage[] }>('GET', '/api/marketplace/held-back'))
    .packages;
}

/**
 * The lines that describe held-back packages, for this command and for the
 * notice `dorkos` prints when the server starts.
 *
 * @param packages - The held-back packages.
 * @returns Printable lines; empty when nothing is held back.
 */
export function describeHeldBack(packages: readonly HeldBackPackage[]): string[] {
  if (packages.length === 0) return [];
  const lines = [
    packages.length === 1
      ? '1 globally installed package is held back from every session:'
      : `${packages.length} globally installed packages are held back from every session:`,
  ];
  for (const pkg of packages) {
    const version = pkg.version ? ` ${pkg.version}` : '';
    lines.push(`  ${pkg.name}${version}: ${pkg.note}`);
  }
  lines.push('Review one with `dorkos marketplace held-back --allow <name>`.');
  return lines;
}

/**
 * Print the held-back notice when `dorkos` starts, asking the server it just
 * started. Quiet when nothing is held back, and when the answer cannot be
 * had: this is a notice, never a reason to disturb the start.
 */
export async function printHeldBackNotice(): Promise<void> {
  try {
    const lines = describeHeldBack(await fetchHeldBack());
    if (lines.length === 0) return;
    console.log('');
    for (const line of lines) console.log(`  ${line}`);
    console.log('');
  } catch {
    // The server answers this at the next start; nothing to report now.
  }
}

/**
 * Implements `dorkos marketplace held-back`.
 *
 * @param args - Parsed arguments.
 * @returns `0` on success, `1` when the server refused or the package cannot
 *   be decided.
 */
export async function runMarketplaceHeldBack(args: MarketplaceHeldBackArgs): Promise<number> {
  const packages = await fetchHeldBack();
  const name = args.allow ?? args.refuse;
  if (name === undefined) {
    const lines = describeHeldBack(packages);
    console.log(lines.length > 0 ? lines.join('\n') : 'Nothing is held back.');
    return 0;
  }

  const pkg = packages.find((p) => p.name === name);
  if (!pkg) {
    console.error(`${name} is not held back.`);
    return 1;
  }
  if (!pkg.effects || !pkg.contentHash) {
    console.error(pkg.note);
    return 1;
  }

  const decision = args.allow !== undefined ? 'allow' : 'refuse';
  console.log(
    `${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}${pkg.source ? `, from ${pkg.source}` : ''}`
  );
  if (pkg.changedSinceApproval) {
    console.log(
      'Its files changed since you last approved it. DorkOS cannot tell who changed them.'
    );
  }
  console.log('It runs, in every session:');
  for (const line of renderDisclosureLines(pkg.effects, 'global')) console.log(line);
  console.log('');

  if (decision === 'allow' && !args.yes) {
    const proceed = await confirm(`Let ${pkg.name} run these in every session?`);
    if (!proceed) {
      console.log('Nothing was recorded. It stays held back.');
      return 0;
    }
  }

  try {
    await apiCall<void>(
      'POST',
      `/api/marketplace/held-back/${encodeURIComponent(pkg.name)}/decision`,
      { decision, contentHash: pkg.contentHash }
    );
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Nothing was recorded: ${err.message}`);
      return 1;
    }
    throw err;
  }
  console.log(
    decision === 'allow'
      ? `Allowed. ${pkg.name} loads into sessions from the next message on.`
      : `Turned down. ${pkg.name} stays held back until it changes or you allow it here.`
  );
  return 0;
}
