/**
 * Handler factory for the `marketplace_create_package` MCP tool.
 *
 * Scaffolds a new marketplace package on disk under the user's personal
 * marketplace (`${dorkHome}/personal-marketplace/packages/<name>/`) and
 * registers it in the personal `marketplace.json` so that
 * `marketplace_search`, `marketplace_get`, and the rest of the read-side
 * tools pick it up immediately.
 *
 * Like every mutation tool in this directory, the handler routes through the
 * shared {@link ConfirmationProvider} gate before any disk write — creating
 * files on the user's machine is a trust boundary and must be explicitly
 * approved (or auto-approved via `MARKETPLACE_AUTO_APPROVE=1`).
 *
 * The actual `server.tool(...)` registration is performed by the phase-4
 * server-wiring task (#14) which imports this factory alongside its
 * siblings. This file deliberately exports only the handler so parallel
 * Phase 2/3 batches do not need to touch `marketplace-mcp-tools.ts`.
 *
 * @module services/marketplace-mcp/tool-create-package
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { createPackage } from '@dorkos/marketplace/scaffolder';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import { PERSONAL_MARKETPLACE_NAME, personalMarketplaceRoot } from './personal-marketplace.js';

/**
 * Zod schema fragment registered as the `marketplace_create_package` tool's
 * input shape. Mirrors the `server.tool(name, description, schema, handler)`
 * convention used elsewhere in the MCP surface — each property is a
 * standalone Zod type rather than a single object schema so the SDK can
 * generate per-argument metadata.
 */
export const CreatePackageInputSchema = {
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'Package name must be kebab-case and start with a lowercase letter')
    .describe('Package name (kebab-case, must start with a letter)'),
  type: z
    .enum(['agent', 'plugin', 'skill-pack', 'adapter'])
    .describe('Package type — determines the starter file layout'),
  description: z
    .string()
    .min(1)
    .max(1024)
    .describe('Human-readable description written into the manifest'),
  author: z.string().optional().describe('Optional author name written into the manifest'),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      'Token returned by an earlier call when the request was pending — re-call with this token after the user approves'
    ),
} as const;

/** Strongly-typed input accepted by {@link createCreatePackageHandler}. */
export interface CreatePackageInput {
  name: string;
  type: 'agent' | 'plugin' | 'skill-pack' | 'adapter';
  description: string;
  author?: string;
  confirmationToken?: string;
}

/**
 * Render an MCP text content block from a JSON-serializable payload. Return
 * type is inferred so the MCP SDK's `CallToolResult` shape (with its index
 * signature) accepts this directly at the registration site.
 */
function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/** Format an unknown error as a structured MCP error content block. */
function errorContent(err: unknown, code: string) {
  return jsonContent(
    {
      status: 'error',
      code,
      error: err instanceof Error ? err.message : String(err),
    },
    true
  );
}

/**
 * Build the `marketplace_create_package` tool handler bound to the given
 * dependency bundle. The returned async function gates on the confirmation
 * provider, scaffolds the package via `createPackage()`, and appends a
 * matching entry to the personal `marketplace.json`.
 *
 * @param deps - Marketplace MCP dependency bundle.
 * @returns An async MCP handler that accepts a {@link CreatePackageInput}.
 */
export function createCreatePackageHandler(deps: MarketplaceMcpDeps) {
  return async (args: CreatePackageInput) => {
    // 1. Confirmation gate — fires BEFORE any disk write. This is the trust
    //    boundary: external agents cannot create files on the user's machine
    //    without explicit approval (or `MARKETPLACE_AUTO_APPROVE=1`).
    const confirmation = args.confirmationToken
      ? await deps.confirmationProvider.resolveToken(args.confirmationToken)
      : await deps.confirmationProvider.requestInstallConfirmation({
          packageName: args.name,
          marketplace: PERSONAL_MARKETPLACE_NAME,
          operation: 'create-package',
        });

    if (confirmation.status === 'pending') {
      return jsonContent({
        status: 'requires_confirmation',
        confirmationToken: confirmation.token,
        message:
          'User must confirm package creation before files are written. Re-call with the token after approval.',
      });
    }

    if (confirmation.status === 'declined') {
      return jsonContent({
        status: 'declined',
        reason: confirmation.reason ?? 'User declined package creation',
      });
    }

    // 2. Scaffold the package directory tree on disk. Any failure here
    //    (directory exists, I/O error, permissions) is reported as
    //    `CREATE_FAILED` so external agents can recover gracefully.
    const packagesDir = path.join(personalMarketplaceRoot(deps.dorkHome), 'packages');
    let result;
    try {
      result = await createPackage({
        parentDir: packagesDir,
        name: args.name,
        type: args.type,
        description: args.description,
        author: args.author,
      });
    } catch (err) {
      return errorContent(err, 'CREATE_FAILED');
    }

    // 3. Register the new package in personal marketplace.json so search /
    //    list / get pick it up immediately. Failures are non-fatal — the
    //    files are already on disk, we just log a warning so the user-visible
    //    result still reflects the successful scaffold.
    try {
      await registerInPersonalMarketplace(deps.dorkHome, {
        name: args.name,
        type: args.type,
        description: args.description,
        source: `file://${result.packagePath}`,
      });
    } catch (err) {
      deps.logger.warn(
        '[marketplace_create_package] failed to register in personal marketplace.json',
        {
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }

    return jsonContent({
      status: 'created',
      packagePath: result.packagePath,
      filesCreated: result.filesWritten,
    });
  };
}

/**
 * Append a new entry to `${dorkHome}/personal-marketplace/marketplace.json`.
 * Idempotent: if `plugins[]` already contains an entry with the same name,
 * the function returns without modifying the file. This guards the
 * personal marketplace from duplicate registrations when an author re-runs
 * the create flow against an existing package.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param entry - Plugin entry to append.
 */
async function registerInPersonalMarketplace(
  dorkHome: string,
  entry: { name: string; type: string; description: string; source: string }
): Promise<void> {
  const manifestPath = path.join(personalMarketplaceRoot(dorkHome), 'marketplace.json');
  const raw = await readFile(manifestPath, 'utf-8');
  const json = JSON.parse(raw) as {
    name: string;
    description?: string;
    plugins?: { name: string }[];
  };
  const plugins = (json.plugins ?? []) as { name: string }[];
  if (plugins.some((p) => p.name === entry.name)) {
    return;
  }
  plugins.push({
    name: entry.name,
    type: entry.type,
    description: entry.description,
    source: entry.source,
  } as { name: string });
  json.plugins = plugins;
  await writeFile(manifestPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
}
