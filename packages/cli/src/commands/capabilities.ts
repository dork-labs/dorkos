/**
 * CLI handler for `dorkos capabilities`.
 *
 * Reads the live capability catalog from the running server
 * (`GET /api/capabilities/catalog`) — the same self-description the
 * `list_capabilities` MCP tool and the `dorkos://capabilities` resource serve.
 * This is how a Codex or OpenCode agent (no in-session MCP tools) asks a running
 * DorkOS "what can I do here?".
 *
 * Default output is a table of id, tier, and title; `--json` prints the raw
 * catalog to stdout (and nothing else) so it pipes cleanly into `jq`. Returns an
 * exit code rather than calling `process.exit` so `cli.ts` stays the single
 * source of truth for termination.
 *
 * @module commands/capabilities
 */
import { apiCall } from '../lib/api-client.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';

/** Help text for `dorkos capabilities` (`--help`), rendered by the `cli.ts` interceptor. */
export const CAPABILITIES_HELP = `Usage: dorkos capabilities [options]

List everything you can do in this DorkOS — the live capability catalog from the
running server (id, tier, title). This is the CLI form of the list_capabilities
tool and the dorkos://capabilities resource.

Options:
      --json   Print the raw catalog JSON instead of a table

Examples:
  dorkos capabilities
  dorkos capabilities --json`;

/** One capability entry as returned by `GET /api/capabilities/catalog`. */
interface CatalogCapability {
  id: string;
  title: string;
  description: string;
  tier: string;
}

/** The catalog payload as returned by `GET /api/capabilities/catalog`. */
interface Catalog {
  catalogVersion: string;
  generatedAt: string;
  capabilities: CatalogCapability[];
}

/** Parsed arguments for `dorkos capabilities`. */
export interface CapabilitiesArgs {
  json: boolean;
}

/**
 * Parse the argv slice after `dorkos capabilities`. The only option is `--json`;
 * anything else is rejected with usage, matching the other operator verbs.
 *
 * @param rawArgs - Argv after `capabilities`.
 * @returns Typed {@link CapabilitiesArgs}.
 */
export function parseCapabilitiesArgs(rawArgs: string[]): CapabilitiesArgs {
  const usage = 'Usage: dorkos capabilities [--json]';
  let json = false;
  for (const arg of rawArgs) {
    if (arg === '--json') {
      json = true;
    } else {
      throw new Error(`Unknown option for 'capabilities': ${arg}\n${usage}`);
    }
  }
  return { json };
}

/**
 * Implements `dorkos capabilities`.
 *
 * @param args - Parsed capabilities arguments.
 * @returns The intended process exit code.
 */
export async function runCapabilities(args: CapabilitiesArgs): Promise<number> {
  try {
    const catalog = await apiCall<Catalog>('GET', '/api/capabilities/catalog');
    if (args.json) {
      printJson(catalog);
      return 0;
    }
    const sorted = [...catalog.capabilities].sort((a, b) => a.id.localeCompare(b.id));
    const rows = sorted.map((c) => [c.id, c.tier, c.title]);
    console.log(renderTable(['ID', 'TIER', 'TITLE'], rows));
    console.log(`\n${sorted.length} capabilities (catalog ${catalog.catalogVersion}).`);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}
