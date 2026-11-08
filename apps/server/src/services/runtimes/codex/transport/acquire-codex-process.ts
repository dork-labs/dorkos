/** Resolve the launch environment and acquire the matching Codex process. */
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import { CreditsUnavailableError } from '../../../core/cloud/credits-protocols.js';
import { creditsCodexHome, resolveCodexHome } from '../codex-home.js';
import { codexCreditsAppServerEnv, ensureCreditsCodexHome } from '../credits-launch.js';
import type { CodexAppServerPool, CodexAppServerProcess } from '../app-server/process-pool.js';
import type { AppServerTransportOptions } from './app-server-transport.js';

/**
 * Acquire the person's or credits process without transport bookkeeping.
 *
 * @param binary - Resolved Codex binary.
 * @param onCredits - Whether this turn uses credits.
 * @param pool - Processes shared by the transport.
 * @param options - Launch environment and relay collaborators.
 */
export async function acquireCodexProcess(
  binary: string,
  onCredits: boolean,
  pool: CodexAppServerPool,
  options: AppServerTransportOptions
): Promise<CodexAppServerProcess> {
  if (onCredits) {
    if (!options.creditsRelay?.()) throw new CreditsUnavailableError('unreachable', 'Codex');
    ensureCreditsCodexHome();
    const env =
      options.environment?.credits() ??
      codexCreditsAppServerEnv(runtimeEnvironment('codex', 'turn'));
    return pool.acquire({ binary, codexHome: creditsCodexHome(), env, onCredits: true });
  }
  const env = options.environment?.person() ?? runtimeEnvironment('codex', 'turn');
  return pool.acquire({ binary, codexHome: resolveCodexHome(env), env });
}
