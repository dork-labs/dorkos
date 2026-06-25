/**
 * Write a workspace's allocated port block into its `.env` so the dev servers it
 * starts (turbo/dotenv) read collision-free ports — the server-side replacement
 * for `worktree-setup.sh`'s hash-mod-150 derivation.
 *
 * @module server/services/workspace/port-env
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspacePorts } from '@dorkos/shared/workspace';

/** Upsert `KEY=value` into an `.env` body, preserving all other lines. */
function upsertEnvLine(body: string, key: string, value: number): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(body)) return body.replace(re, line);
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}${line}\n`;
}

/**
 * Merge the allocated `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT` into the workspace's
 * `.env`, preserving any existing keys (e.g. copied secrets).
 *
 * @param workspacePath - The checkout directory.
 * @param ports - The allocated named ports.
 */
export async function writePortEnv(workspacePath: string, ports: WorkspacePorts): Promise<void> {
  const envPath = path.join(workspacePath, '.env');
  let body = '';
  try {
    body = await fs.readFile(envPath, 'utf-8');
  } catch {
    body = '';
  }
  body = upsertEnvLine(body, 'DORKOS_PORT', ports.DORKOS_PORT);
  body = upsertEnvLine(body, 'VITE_PORT', ports.VITE_PORT);
  body = upsertEnvLine(body, 'SITE_PORT', ports.SITE_PORT);
  await fs.writeFile(envPath, body, 'utf-8');
}
