/**
 * CLI handler for `dorkos marketplace unlink <name>` (DOR-2696).
 *
 * Stops a package running from a folder on this computer: the installed copy
 * set aside when it was linked comes back, or, when there was none, the
 * package is removed. The folder itself is never touched. Calls
 * `POST /api/marketplace/dev-links/:name/unlink`.
 *
 * Only a person can unlink, not an agent; with sign-in on, only a person
 * signed in to the app. The route enforces both, and this prints its refusal.
 *
 * @module commands/marketplace-unlink
 */
import { parseArgs } from 'node:util';
import { apiCall } from '../lib/api-client.js';
import { printError, printJson } from '../lib/operator-output.js';
import { resolveProjectFlag } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceUnlink}. */
export interface MarketplaceUnlinkArgs {
  /** The package name. */
  name: string;
  /** Absolute project path for a project link; absent for every session. */
  projectPath?: string;
  /** Print the server's answer as JSON. */
  json: boolean;
}

/** What unlink did. Mirrors `DevUnlinkResult` on the server. */
export interface UnlinkResultBody {
  /** `installed` when the set-aside copy is back, `removed` when the package is gone. */
  restored: 'installed' | 'removed';
  /** Where the set-aside copy still is, when something else held its place. */
  parkedLeftAt?: string;
  /** Set when something else had already taken the link's place; it was left as it is. */
  leftInPlace?: true;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace unlink <name> [--project <path>] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace unlink`.
 *
 * @param rawArgs - The argv slice after `unlink`.
 * @returns A typed {@link MarketplaceUnlinkArgs} object.
 */
export function parseMarketplaceUnlinkArgs(rawArgs: string[]): MarketplaceUnlinkArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace unlink', USAGE_LINE);
  }
  const { values, positionals } = parsed;
  const name = positionals[0];
  if (!name) throw new Error(`Missing required <name> argument.\n${USAGE_LINE}`);
  return {
    name,
    projectPath: resolveProjectFlag(values.project),
    json: Boolean(values.json),
  };
}

/**
 * What to tell the person unlink did. Pure.
 *
 * @param name - The package name.
 * @param result - The server's answer.
 * @returns The lines to print.
 */
export function describeUnlink(name: string, result: UnlinkResultBody): string[] {
  if (result.restored === 'installed') return [`Your installed copy of ${name} is back.`];
  if (result.parkedLeftAt) {
    return [
      `Unlinked ${name}. Your folder was not touched.`,
      `Your installed copy couldn't go back because something else is in its place. It is still at ${result.parkedLeftAt}.`,
    ];
  }
  // Only the record went: what is in the slot now is not the dev link, and
  // unlink did not touch it, so it is not "removed".
  if (result.leftInPlace) {
    return [
      `Unlinked ${name}. Your folder was not touched.`,
      'Something else had already taken its place, and that was left as it is.',
    ];
  }
  return [`${name} removed. Your folder was not touched.`];
}

/**
 * Implements `dorkos marketplace unlink <name>`.
 *
 * @param args - Parsed arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runMarketplaceUnlink(args: MarketplaceUnlinkArgs): Promise<number> {
  let result: UnlinkResultBody;
  try {
    result = await apiCall<UnlinkResultBody>(
      'POST',
      `/api/marketplace/dev-links/${encodeURIComponent(args.name)}/unlink`,
      args.projectPath ? { scope: 'project', projectPath: args.projectPath } : { scope: 'global' }
    );
  } catch (err) {
    // The route's refusals (an agent, or sign-in on) are already plain sentences.
    printError(err);
    return 1;
  }
  if (args.json) {
    printJson(result);
    return 0;
  }
  for (const line of describeUnlink(args.name, result)) console.log(line);
  return 0;
}
