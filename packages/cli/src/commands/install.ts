/**
 * CLI handler for `dorkos install <name>`.
 *
 * Talks to a running DorkOS server via the marketplace HTTP API:
 *
 * 1. `POST /api/marketplace/packages/:name/preview` to fetch the manifest
 *    and compute a `PermissionPreview`.
 * 2. Render the preview, prompt for confirmation (unless `--yes` or
 *    non-TTY), and bail on error-level conflicts unless `--force`.
 * 3. `POST /api/marketplace/packages/:name/install` to perform the install.
 * 4. Print a one-line success summary or a clean error.
 *
 * Returns the intended exit code rather than calling `process.exit` so the
 * top-level dispatcher in `cli.ts` retains the single source of truth for
 * process termination.
 *
 * @module commands/install
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
import { confirm } from '../lib/confirm-prompt.js';
import { hasBlockingConflicts, renderPreview, type PreviewPayload } from '../lib/preview-render.js';

/** Parsed CLI arguments accepted by {@link runInstall}. */
export interface InstallArgs {
  /** Package name (may include `@<marketplace>` or `@<source>` qualifier). */
  name: string;
  /** Marketplace identifier (e.g. `dorkos-community`). */
  marketplace?: string;
  /** Explicit source URL — overrides marketplace lookup. */
  source?: string;
  /** Force install past warning-level conflicts. */
  force?: boolean;
  /** Skip the interactive confirmation prompt. */
  yes?: boolean;
  /** Project path for project-local installs. */
  projectPath?: string;
}

/** Install API response shape. Mirrors {@link InstallResult} on the server. */
interface InstallResultBody {
  ok: boolean;
  packageName: string;
  version: string;
  type: string;
  installPath: string;
  warnings?: string[];
}

/** Preview API response shape — `{ preview, manifest, packagePath }`. */
interface PreviewResponseBody {
  preview: PreviewPayload;
  manifest: { name: string; version: string };
  packagePath: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos install <name> [--marketplace <name>] [--source <url>] ' +
  '[--force] [--yes] [--project <path>]';

/**
 * Parse the raw argv slice that follows `dorkos install`. Splits the
 * positional name on `@` to support the `<name>@<marketplace>` shorthand
 * documented in the spec.
 *
 * @param rawArgs - The argv slice after `install` (i.e. `process.argv.slice(3)`).
 * @returns A typed {@link InstallArgs} object.
 */
export function parseInstallArgs(rawArgs: string[]): InstallArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        marketplace: { type: 'string' },
        source: { type: 'string' },
        force: { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        project: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'install': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  const { values, positionals } = parsed;
  const rawName = positionals[0];
  if (!rawName) {
    throw new Error(`Missing required <name> argument.\n${USAGE_LINE}`);
  }

  // Support `<name>@<marketplace>` shorthand. The portion after the first
  // `@` is treated as the marketplace identifier unless `--marketplace`
  // was passed explicitly. We deliberately do not try to detect git URLs
  // here — the user can pass `--source` for that.
  let name = rawName;
  let marketplace = typeof values.marketplace === 'string' ? values.marketplace : undefined;
  const atIndex = rawName.indexOf('@');
  if (atIndex > 0 && !marketplace) {
    name = rawName.slice(0, atIndex);
    marketplace = rawName.slice(atIndex + 1);
  }

  return {
    name,
    marketplace,
    source: typeof values.source === 'string' ? values.source : undefined,
    force: Boolean(values.force),
    yes: Boolean(values.yes),
    projectPath: typeof values.project === 'string' ? values.project : undefined,
  };
}

/**
 * Implements `dorkos install <name>`.
 *
 * @param args - Parsed install arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runInstall(args: InstallArgs): Promise<number> {
  try {
    const preview = await apiCall<PreviewResponseBody>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/preview`,
      buildRequestBody(args)
    );

    console.log(renderPreview(preview.manifest.name, preview.manifest.version, preview.preview));
    console.log('');

    if (hasBlockingConflicts(preview.preview) && !args.force) {
      console.error('Install blocked by error-level conflicts. Re-run with --force to override.');
      return 1;
    }

    if (!args.yes) {
      const proceed = await confirm('Continue with install?');
      if (!proceed) {
        console.log('Install cancelled.');
        return 0;
      }
    }

    const result = await apiCall<InstallResultBody>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/install`,
      buildRequestBody(args)
    );

    console.log(`Installed ${result.packageName}@${result.version} to ${result.installPath}`);
    if (result.warnings && result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(`  warning: ${warning}`);
      }
    }
    return 0;
  } catch (err) {
    printApiError(err);
    return 1;
  }
}

/**
 * Build the JSON body shared by the preview and install endpoints. Both
 * accept the same `InstallRequest` schema minus the `name`, which is
 * always carried in the URL.
 */
function buildRequestBody(args: InstallArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.marketplace) body.marketplace = args.marketplace;
  if (args.source) body.source = args.source;
  if (args.force) body.force = true;
  if (args.yes) body.yes = true;
  if (args.projectPath) body.projectPath = args.projectPath;
  return body;
}

/**
 * Render an API error to stderr. {@link ApiError} carries the structured
 * server response, so we can pull `conflicts` out of HTTP 409 bodies and
 * render them in a useful way instead of just printing the message.
 */
function printApiError(err: unknown): void {
  if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
    if (err.status === 409 && Array.isArray(err.body.conflicts)) {
      console.error('Conflicts:');
      for (const conflict of err.body.conflicts) {
        if (conflict && typeof conflict === 'object' && 'description' in conflict) {
          const desc = (conflict as { description: unknown }).description;
          console.error(`  ${typeof desc === 'string' ? desc : JSON.stringify(conflict)}`);
        }
      }
    }
    return;
  }
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
}
