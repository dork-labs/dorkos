import { parseArgs } from 'node:util';

import { createPackage } from '@dorkos/marketplace/scaffolder';
import { PackageTypeSchema, type PackageType } from '@dorkos/marketplace/package-types';

/**
 * Parsed arguments accepted by {@link runPackageInit}.
 *
 * `name` is the only required field. `type` defaults to `'plugin'` and
 * `parentDir` defaults to `process.cwd()` when undefined.
 */
export interface PackageInitArgs {
  /** Package name (kebab-case). Becomes the directory name and `manifest.name`. */
  name: string;
  /** Package type — one of the four allowed values. Defaults to `'plugin'`. */
  type?: PackageType;
  /** Parent directory in which to create the package. Defaults to `process.cwd()`. */
  parentDir?: string;
  /** Optional description for the manifest. */
  description?: string;
  /** Optional author for the manifest. */
  author?: string;
  /**
   * Adapter implementation identifier (e.g. `'discord'`, `'slack'`). Only
   * meaningful when `type === 'adapter'`. Forwarded to the scaffolder, which
   * defaults to the package name when omitted. Ignored for non-adapter types.
   */
  adapterType?: string;
}

/** Allowed values for the `--type` flag, derived from the canonical schema. */
const ALLOWED_PACKAGE_TYPES: readonly PackageType[] = PackageTypeSchema.options;

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos package init <name> [--type agent|plugin|skill-pack|adapter] ' +
  '[--parent-dir <path>] [--description <text>] [--author <text>] [--adapter-type <id>]';

/**
 * Parse raw CLI arguments for `dorkos package init` into a typed
 * {@link PackageInitArgs} object.
 *
 * Expected shape: `<name> [--type <type>] [--parent-dir <path>]
 * [--description <text>] [--author <text>] [--adapter-type <id>]`.
 *
 * Throws an `Error` (caught and formatted by the CLI dispatcher) when
 * `<name>` is missing, `--type` is invalid, or an unknown option is passed.
 * Never calls `process.exit` directly — exit-code policy lives in the
 * top-level dispatcher in `cli.ts`.
 *
 * @param rawArgs - Raw argv slice that comes after `package init`.
 * @returns Parsed and validated {@link PackageInitArgs}.
 */
export function parsePackageInitArgs(rawArgs: string[]): PackageInitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        type: { type: 'string' },
        'parent-dir': { type: 'string' },
        description: { type: 'string' },
        author: { type: 'string' },
        'adapter-type': { type: 'string' },
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
      throw new Error(`Unknown option for 'package init': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  const { values, positionals } = parsed;
  const name = positionals[0];
  if (!name) {
    throw new Error(`Missing required <name> argument.\n${USAGE_LINE}`);
  }

  let type: PackageType | undefined;
  const rawType = values.type;
  if (typeof rawType === 'string' && rawType.length > 0) {
    const result = PackageTypeSchema.safeParse(rawType);
    if (!result.success) {
      throw new Error(
        `Invalid --type value: '${rawType}'. Allowed: ${ALLOWED_PACKAGE_TYPES.join(', ')}`
      );
    }
    type = result.data;
  }

  return {
    name,
    type,
    parentDir: typeof values['parent-dir'] === 'string' ? values['parent-dir'] : undefined,
    description: typeof values.description === 'string' ? values.description : undefined,
    author: typeof values.author === 'string' ? values.author : undefined,
    adapterType: typeof values['adapter-type'] === 'string' ? values['adapter-type'] : undefined,
  };
}

/**
 * Implements `dorkos package init <name>`.
 *
 * Thin wrapper over `createPackage` from `@dorkos/marketplace/scaffolder` that
 * scaffolds a new marketplace package directory and prints the resulting path
 * and the list of files written to stdout.
 *
 * Defaults `type` to `'plugin'` when not specified, and `parentDir` to
 * `process.cwd()`.
 *
 * @param args - Parsed arguments for the command.
 */
export async function runPackageInit(args: PackageInitArgs): Promise<void> {
  const result = await createPackage({
    parentDir: args.parentDir ?? process.cwd(),
    name: args.name,
    type: args.type ?? 'plugin',
    description: args.description,
    author: args.author,
    adapterType: args.adapterType,
  });

  console.log(`Created package at: ${result.packagePath}`);
  console.log('Files written:');
  for (const file of result.filesWritten) {
    console.log(`  - ${file}`);
  }
}
