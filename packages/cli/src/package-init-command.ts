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
}

/** Allowed values for the `--type` flag, in canonical order. */
const ALLOWED_PACKAGE_TYPES: readonly PackageType[] = [
  'agent',
  'plugin',
  'skill-pack',
  'adapter',
] as const;

/**
 * Parse raw CLI arguments for `dorkos package init` into a typed
 * {@link PackageInitArgs} object.
 *
 * Expected shape: `<name> [--type <type>] [--parent-dir <path>]
 * [--description <text>] [--author <text>]`.
 *
 * Validates `--type` against the four allowed package types and exits the
 * process with a non-zero code if the value is invalid or if `<name>` is
 * missing. Designed to be invoked from the CLI dispatcher with the
 * positional/option slice that follows `package init`.
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
      console.error(`Unknown option for 'package init': ${option}`);
      console.error(
        `Usage: dorkos package init <name> [--type <type>] [--parent-dir <path>] [--description <text>] [--author <text>]`
      );
      process.exit(1);
    }
    throw err;
  }

  const { values, positionals } = parsed;
  const name = positionals[0];
  if (!name) {
    console.error('Usage: dorkos package init <name> [--type agent|plugin|skill-pack|adapter]');
    process.exit(1);
  }

  let type: PackageType | undefined;
  const rawType = values.type;
  if (typeof rawType === 'string' && rawType.length > 0) {
    const result = PackageTypeSchema.safeParse(rawType);
    if (!result.success) {
      console.error(
        `Invalid --type value: '${rawType}'. Allowed: ${ALLOWED_PACKAGE_TYPES.join(', ')}`
      );
      process.exit(1);
    }
    type = result.data;
  }

  return {
    name,
    type,
    parentDir: typeof values['parent-dir'] === 'string' ? values['parent-dir'] : undefined,
    description: typeof values.description === 'string' ? values.description : undefined,
    author: typeof values.author === 'string' ? values.author : undefined,
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
  });

  console.log(`Created package at: ${result.packagePath}`);
  console.log('Files written:');
  for (const file of result.filesWritten) {
    console.log(`  - ${file}`);
  }
}
