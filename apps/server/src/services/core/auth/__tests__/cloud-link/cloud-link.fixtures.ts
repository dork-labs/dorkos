import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { configManager, initConfigManager } from '../../../config-manager.js';

/** Immediate, deterministic sleep so the background poll settles synchronously. */
export const noSleep = async (): Promise<void> => {};

export type Step = { status: number; body: unknown };

/** A fetch that routes by cloud endpoint path, returning per-endpoint canned responses. */
export function routerFetch(handlers: {
  code?: () => Step;
  token?: () => Step;
  heartbeat?: () => Step;
  revoke?: () => Step;
  authority?: () => Step;
  execution?: () => Step;
  usage?: () => Step;
  authentication?: () => Step;
}) {
  return vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    let step: Step | undefined;
    if (p.endsWith('/device/code')) step = handlers.code?.();
    else if (p.endsWith('/device/token')) step = handlers.token?.();
    else if (p.endsWith('/instances/heartbeat')) step = handlers.heartbeat?.();
    else if (p.endsWith('/instances/revoke')) step = handlers.revoke?.();
    else if (p.includes('/instances/connectors/authority-commands')) {
      step = handlers.authority?.();
    } else if (p.includes('/instances/connectors/executions')) {
      step = handlers.execution?.();
    } else if (p.includes('/instances/connectors/usage')) {
      step = handlers.usage?.();
    } else if (p.endsWith('/instances/connectors/authentication-flows')) {
      step = handlers.authentication?.();
    }
    if (!step) throw new Error(`unexpected request: ${p}`);
    return new Response(JSON.stringify(step.body), { status: step.status });
  });
}

export const CODES: Step = {
  status: 200,
  body: {
    device_code: 'dev-123',
    user_code: 'ABCD1234',
    verification_uri: 'https://dorkos.ai/activate',
    verification_uri_complete: 'https://dorkos.ai/activate?user_code=ABCD1234',
    expires_in: 1800,
    interval: 5,
  },
};

/**
 * A fresh config folder for every test, and the manager the test built stopped
 * after it.
 *
 * @param prefix - Temp folder name prefix.
 * @param stopManager - Stops whatever manager the test built.
 */
export function useCloudLinkSandbox(
  prefix: string,
  stopManager: () => void
): { readonly dir: string } {
  const sandbox = { dir: '' };
  beforeEach(() => {
    sandbox.dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    initConfigManager(sandbox.dir);
  });
  afterEach(() => {
    stopManager();
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  return sandbox;
}

/**
 * Writes the `cloud` section from the leaves a test names, every other leaf
 * kept at what the section holds now (its defaults on a fresh config).
 *
 * @param leaves - The `cloud` leaves to set.
 */
export function setCloud(leaves: Partial<UserConfig['cloud']>): void {
  configManager.set('cloud', { ...configManager.get('cloud'), ...leaves });
}
