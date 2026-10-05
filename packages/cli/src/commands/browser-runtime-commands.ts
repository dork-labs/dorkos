/** Explicit managed-browser installation commands; legacy sign-in commands stay separate. */
import type {
  InstallResult,
  RuntimeInstallation,
  RuntimeInstallationStatus,
} from '@dorkos/browser/runtime-installation';

const INSTALL_USAGE = 'Usage: dorkos browser install [--repair] [--json]';
const STATUS_USAGE = 'Usage: dorkos browser status --runtime [--json]';

export type BrowserRuntimeArgs =
  | Readonly<{ command: 'install'; repair: boolean; json: boolean }>
  | Readonly<{ command: 'status'; json: boolean }>;

/** A closed grammar prevents runtime flags from changing the legacy status command. */
export class BrowserRuntimeUsageError extends Error {
  constructor(readonly usage: string) {
    super(usage);
    this.name = 'BrowserRuntimeUsageError';
  }
}

/** The dispatcher must select this branch before importing legacy sign-in dependencies. */
export function isBrowserRuntimeInvocation(
  subcommand: string | undefined,
  args: readonly string[]
): boolean {
  return subcommand === 'install' || (subcommand === 'status' && args.includes('--runtime'));
}

/** Parse only the explicit install or runtime-status grammar; reject duplicates and positionals. */
export function parseBrowserRuntimeArgs(
  subcommand: string | undefined,
  args: readonly string[]
): BrowserRuntimeArgs {
  const usage = subcommand === 'install' ? INSTALL_USAGE : STATUS_USAGE;
  if (subcommand !== 'install' && subcommand !== 'status')
    throw new BrowserRuntimeUsageError(usage);
  const allowed = new Set(
    subcommand === 'install' ? ['--repair', '--json'] : ['--runtime', '--json']
  );
  const seen = new Set<string>();
  for (const arg of args) {
    if (!allowed.has(arg) || seen.has(arg)) throw new BrowserRuntimeUsageError(usage);
    seen.add(arg);
  }
  if (subcommand === 'status' && !seen.has('--runtime')) throw new BrowserRuntimeUsageError(usage);
  return subcommand === 'install'
    ? Object.freeze({ command: 'install', repair: seen.has('--repair'), json: seen.has('--json') })
    : Object.freeze({ command: 'status', json: seen.has('--json') });
}

/** Actual packaged composition is supplied by the separately owned dispatcher wiring. */
export interface BrowserRuntimeDeps {
  getRuntimeInstallation(): RuntimeInstallation | Promise<RuntimeInstallation>;
  log(message: string): void;
  error(message: string): void;
  readonly signal?: AbortSignal;
}

function installFailure(result: Extract<InstallResult, { cause: string }>): string {
  if (result.publicationMayHaveChanged || result.state === 'uncertain') {
    return 'Installation could not be confirmed. DorkOS kept the files for inspection.';
  }
  switch (result.cause) {
    case 'PLATFORM_UNSUPPORTED':
      return 'Managed browser installation is not supported on this computer.';
    case 'PUBLICATION_BUSY':
      return 'Another browser installation is in progress. Wait for it to finish.';
    case 'INSTALLATION_INVALID':
    case 'HASH_MISMATCH':
    case 'VERSION_MISMATCH':
    case 'LIBRARY_MISMATCH':
    case 'SOURCE_MISMATCH':
      return 'The browser files could not be verified. Run dorkos browser install --repair.';
    case 'ABORTED':
      return 'Browser installation was cancelled.';
    case 'WORK_EXPIRED':
    case 'FINAL_EXPIRED':
      return 'Browser installation did not finish within its allowed time.';
    default:
      return 'Browser installation could not be completed. No verified installation was confirmed.';
  }
}

function statusText(status: RuntimeInstallationStatus): string[] {
  switch (status.state) {
    case 'installed-files':
      return [
        'Managed browser files are installed.',
        `Last verified browser version: ${status.lastFreshVerifiedVersion}`,
        'This checks the files only. Browser readiness has not been verified.',
      ];
    case 'missing':
      return ['Managed browser files are not installed. Run dorkos browser install.'];
    case 'invalid':
      return ['The browser files could not be verified. Run dorkos browser install --repair.'];
    case 'unsupported':
      return ['Managed browser installation is not supported on this computer.'];
    case 'unverified':
      return ['DorkOS could not check the browser files. Browser readiness has not been verified.'];
  }
}

/**
 * Return an exit code without exiting the process. JSON results always use stdout;
 * human failure messages use stderr. Status never calls install or requests repair.
 */
export async function runBrowserRuntimeCommand(
  subcommand: string | undefined,
  rawArgs: readonly string[],
  deps: BrowserRuntimeDeps
): Promise<number> {
  let args: BrowserRuntimeArgs;
  try {
    args = parseBrowserRuntimeArgs(subcommand, rawArgs);
  } catch (error) {
    const usage = error instanceof BrowserRuntimeUsageError ? error.usage : INSTALL_USAGE;
    if (rawArgs.includes('--json')) {
      deps.log(
        JSON.stringify({ schemaVersion: 1, state: 'refused', cause: 'INVALID_ARGUMENTS', usage })
      );
    } else {
      deps.error(usage);
    }
    return 1;
  }
  try {
    const runtime = await deps.getRuntimeInstallation();
    if (args.command === 'status') {
      const status = await runtime.inspectExisting({ signal: deps.signal });
      if (args.json) deps.log(JSON.stringify(status));
      else for (const line of statusText(status)) deps.log(line);
      return status.state === 'installed-files' ? 0 : 1;
    }
    const result = await runtime.install({ repair: args.repair, signal: deps.signal });
    if (args.json) deps.log(JSON.stringify(result));
    else if (result.cause === null) {
      deps.log(
        result.state === 'verified-reused'
          ? 'Existing managed browser files passed a fresh check.'
          : 'Managed browser files are installed and passed a fresh check.'
      );
      deps.log(`Verified browser version: ${result.observedVersion}`);
      deps.log('Browser readiness has not been verified.');
    } else deps.error(installFailure(result));
    return result.cause === null ? 0 : 1;
  } catch {
    // Do not print raw exceptions, paths, subprocess output or potentially secret environment data.
    if (args.json) {
      deps.log(
        JSON.stringify({
          schemaVersion: 1,
          state: args.command === 'install' ? 'uncertain' : 'unverified',
          cause: 'COMMAND_FAILED',
          publicationMayHaveChanged: args.command === 'install',
          readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
        })
      );
    } else
      deps.error(
        args.command === 'install'
          ? 'DorkOS could not confirm the browser installation. Check its status before trying again.'
          : 'DorkOS could not check the browser files.'
      );
    return 1;
  }
}
