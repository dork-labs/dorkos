/** Join the existing host runtimes and exact owned computer before releasing server authority. */
import type { CreditsRelay } from '../services/core/cloud/credits-relay.js';
import { openCodeServerManager } from '../services/runtimes/opencode/index.js';
import { codexAppServerPool } from '../services/runtimes/codex/app-server/process-pool.js';
import { shutdownSessionPumps } from '../services/runtimes/claude-code/sessions/session-pump-registry.js';
import { logger } from '../lib/logger.js';
import { shutdownComputers } from './computers.js';

/** Preserve host shutdown order, while also retaining and stopping the computer disk. */
export async function shutdownRuntimes(creditsRelay: CreditsRelay | null): Promise<void> {
  try {
    await shutdownComputers();
  } catch {
    // Later index.ts cleanup still owns remote commands, observers and server authority.
    logger.warn('[Computer] shutdown stop unconfirmed', { reason: 'shutdown', code: 'stop-threw' });
  }
  await openCodeServerManager.shutdown();
  await codexAppServerPool.shutdown();
  await creditsRelay?.close();
  await shutdownSessionPumps();
}
