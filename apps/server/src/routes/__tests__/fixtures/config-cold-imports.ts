/** Evaluate the config fixture's cold graph without sharing bootstrap state. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/** Load declarations only: no listener, request or runtime is started. */
async function loadConfigRouteGraph(): Promise<void> {
  await import('../../config.js');
  await import('../../../http/__tests__/hono-group-listener.js');
}

/**
 * Evaluate the cold graph before timed fixtures, then discard its config and policy.
 * Every test still imports and initializes fresh modules in its original hooks.
 *
 * @param load - The declaration loader; injectable to prove isolation and failure cleanup.
 */
export async function preloadConfigRouteModules(
  load: () => Promise<void> = loadConfigRouteGraph
): Promise<void> {
  const previousHome = process.env.DORK_HOME;
  const bootstrapHome = mkdtempSync(join(tmpdir(), 'dorkos-config-cold-import-'));
  process.env.DORK_HOME = bootstrapHome;
  try {
    const { initConfigManager } = await import('../../../services/core/config-manager.js');
    initConfigManager(bootstrapHome);
    await load();
  } finally {
    try {
      vi.resetModules();
    } finally {
      try {
        rmSync(bootstrapHome, { recursive: true, force: true });
      } finally {
        if (previousHome === undefined) delete process.env.DORK_HOME;
        else process.env.DORK_HOME = previousHome;
      }
    }
  }
}
