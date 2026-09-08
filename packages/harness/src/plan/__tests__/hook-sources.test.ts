/**
 * Where a hook line says the hook came FROM.
 *
 * Every line about hooks has to name a file, drops included, or a check that
 * asks "did each authored source reach every harness?" cannot match it (P6). The
 * first version of that rule put `.claude/settings.json` on every hook line
 * including the drops — so a repository with no settings file at all, whose
 * hooks came entirely from an installed package, was told its
 * `.claude/settings.json` hooks were dropped. A path nobody wrote, in a report
 * whose whole job is honesty.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { existsOnDisk, writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';
import type { ProjectionAction } from '../types.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** Stage a repo whose only hooks come from an installed plugin — no settings file. */
function stagePluginOnlyHooks(harnesses: string[]): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-hooksrc-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-hooksrc-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), { version: 1, harnesses });

  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'acme',
    version: '1.0.0',
    type: 'plugin',
    description: 'Acme test plugin',
    layers: ['hooks'],
  });
  writeJsonAt(join(plugin, 'hooks', 'hooks.json'), {
    Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'echo unmappable' }] }],
  });
}

/** Every hook line for one harness, as `[kind, source]`. */
function hookLines(actions: ProjectionAction[], harness: string): [string, string | undefined][] {
  return actions
    .filter((a) => a.artifact === 'hook' && a.harness === harness)
    .map((a) => [a.kind, a.source]);
}

describe('a hook line names the file the hook really came from', () => {
  it('points a plugin-only repo at the plugin, not at a settings file it never wrote', () => {
    stagePluginOnlyHooks(['opencode']);
    expect(existsOnDisk(join(repo, '.claude', 'settings.json'))).toBe(false);

    const plan = project(repo, { dorkHome });
    expect(hookLines(plan.drops, 'opencode')).toEqual([
      ['drop', '.dork/plugins/acme/hooks/hooks.json'],
    ]);
  });

  it('attributes an unmappable event to the file that declared it', () => {
    // Codex generates a hooks file from `Stop` and drops `Notification`. Both
    // came from the package, so both lines name the package's own declaration.
    stagePluginOnlyHooks(['codex']);

    const plan = project(repo, { dorkHome });
    expect(hookLines(plan.actions, 'codex')).toEqual([
      ['generate', '.dork/plugins/acme/hooks/hooks.json'],
    ]);
    expect(hookLines(plan.drops, 'codex')).toEqual([
      ['drop', '.dork/plugins/acme/hooks/hooks.json'],
    ]);
  });

  it('names the authored settings file when the repository is the one that declared it', () => {
    stagePluginOnlyHooks(['opencode']);
    writeFileAt(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } })
    );

    const plan = project(repo, { dorkHome });
    // Two contributing files, two honest lines — the person's own first.
    expect(hookLines(plan.drops, 'opencode')).toEqual([
      ['drop', '.claude/settings.json'],
      ['drop', '.dork/plugins/acme/hooks/hooks.json'],
    ]);
  });
});
