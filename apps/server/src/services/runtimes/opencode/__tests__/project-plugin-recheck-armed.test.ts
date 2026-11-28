/**
 * Once a turn's request goes out, DorkOS checks its folders for a project's own
 * plugins without waiting on an event: when the request resolves, about a
 * second in, and, for compaction, right before the summary is asked for
 * (DOR-5258). Real folders; the restart is a stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
  ARMED_CHECK_MS,
  PLUGIN_RESTART_MESSAGE,
  ProjectPluginRecheck,
  setPluginRestartActivity,
} from '../messaging/project-plugin-recheck.js';
import { summarizeOpenCodeSession } from '../messaging/compaction-model.js';

const roots: string[] = [];

afterEach(() => {
  setPluginRestartActivity(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A made-up repo in a throwaway folder. */
function repo(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-plugin-armed-')));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

/** What a clone of a repo with its own plugin leaves in `dir`. */
function dropPlugin(dir: string): void {
  mkdirSync(join(dir, '.opencode', 'plugin'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'plugin', 'x.js'), 'export default {}\n');
}

describe('once a turn is armed, its folders are checked without waiting on an event', () => {
  /** One turn's pass, armed as its request goes out, with what its checks did. */
  async function armedTurn(dir: string) {
    const restart = vi.fn(async () => {});
    const pass = await new ProjectPluginRecheck(restart).admit(dir);
    const stop = vi.fn();
    pass.assertNoPlugins(dir);
    pass.beforeSend(stop, () => {})();
    return { pass, stop, restart };
  }

  it('checks again when the request resolves, after an earlier event found none', async () => {
    const dir = repo('northwind-widgets');
    const { pass, stop, restart } = await armedTurn(dir);
    expect(pass.atEvent(dir)).toBe(false);
    dropPlugin(dir);
    await pass.sent(Promise.resolve());
    expect(stop).toHaveBeenCalledWith(new Error(PLUGIN_RESTART_MESSAGE));
    expect(restart).toHaveBeenCalledTimes(1);
    pass.afterTurn(dir);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('a request the restart cuts off ends as the restart, and any other failure still throws', async () => {
    const dir = repo('northwind-widgets');
    const { pass, stop } = await armedTurn(dir);
    dropPlugin(dir);
    expect(pass.atEvent(dir)).toBe(true);
    await expect(
      pass.sent(Promise.reject(new Error('other side closed')))
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    const clean = await armedTurn(repo('plain-repo'));
    await expect(clean.pass.sent(Promise.reject(new Error('refused')))).rejects.toThrow('refused');
  });

  it('checks about a second in when no event comes', async () => {
    vi.useFakeTimers();
    try {
      const dir = repo('northwind-widgets');
      const { pass, stop, restart } = await armedTurn(dir);
      dropPlugin(dir);
      vi.advanceTimersByTime(ARMED_CHECK_MS - 1);
      expect(stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(stop).toHaveBeenCalledWith(new Error(PLUGIN_RESTART_MESSAGE));
      expect(restart).toHaveBeenCalledTimes(1);
      pass.afterTurn(dir);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compaction arms the checks right before it asks for the summary', async () => {
    const order: string[] = [];
    const client = {
      session: { summarize: vi.fn(async () => (order.push('summarize'), { data: true })) },
    } as unknown as OpencodeClient;
    const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' };
    await summarizeOpenCodeSession(client, 'ses_1', model, () => order.push('arm'));
    expect(order).toEqual(['arm', 'summarize']);
  });
});
