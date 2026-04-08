/**
 * CLI handler for `dorkos package validate [path]`.
 *
 * Thin wrapper over {@link validatePackage} from `@dorkos/marketplace` that
 * formats validation results for terminal output. Returns the intended exit
 * code rather than calling `process.exit` directly so the top-level CLI
 * dispatcher remains the single source of truth for process termination.
 *
 * @module package-validate-command
 */

import path from 'node:path';
import { validatePackage } from '@dorkos/marketplace/package-validator';

/**
 * Arguments accepted by {@link runPackageValidate}.
 */
export interface PackageValidateArgs {
  /**
   * Optional path to the package directory. When omitted, defaults to the
   * current working directory.
   */
  packagePath?: string;
}

/**
 * Implements `dorkos package validate [path]`.
 *
 * Validates a marketplace package on disk and prints a structured report to
 * stdout. Each issue is rendered with a severity prefix (`✗` for errors,
 * `⚠` for warnings), the issue code, the message, and an optional path. A
 * trailing status line summarises the result. Returns `1` when any error
 * was reported, `0` otherwise (warnings-only packages still return `0`).
 *
 * @param args - Resolved CLI arguments.
 * @returns The intended process exit code.
 */
export async function runPackageValidate(args: PackageValidateArgs): Promise<number> {
  const packagePath = path.resolve(args.packagePath ?? process.cwd());
  const result = await validatePackage(packagePath);

  if (result.manifest) {
    console.log(
      `Package: ${result.manifest.name}@${result.manifest.version} (${result.manifest.type})`
    );
  }

  if (result.issues.length === 0) {
    console.log('✓ Package is valid');
    return 0;
  }

  for (const issue of result.issues) {
    const prefix = issue.level === 'error' ? '✗' : '⚠';
    const location = issue.path ? ` (${issue.path})` : '';
    console.log(`${prefix} [${issue.code}] ${issue.message}${location}`);
  }

  if (result.ok) {
    console.log('✓ Package is valid (with warnings)');
    return 0;
  }

  console.log('✗ Package validation failed');
  return 1;
}
