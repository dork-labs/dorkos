/**
 * Case 10 — the no-loss case: what a DorkOS-driven Claude Code session still
 * gets after the user tier ships.
 *
 * An earlier draft of the global-scope design had this slice DELETE the global
 * SDK-injection path, citing ADR 260706-192819 as the precedent. That was wrong,
 * and the review caught it. `plugin-activation.ts` says what injection actually
 * delivers: each enabled package under `<dorkHome>/plugins/<name>/` becomes a
 * `{ type: 'local', path }` entry the SDK auto-loads — **skills, commands,
 * agents, hooks and MCP servers**, five kinds. The user tier this slice builds
 * delivers ONE, because hooks, commands, instructions and MCP servers are
 * refused at user scope with reasons the spec stands behind (§2.10). Deleting
 * injection would take four kinds away from the one surface that has them.
 *
 * `260706-192819` retired injection at PROJECT scope, where harness-native
 * projection covers every kind injection did. At global scope the projection
 * covers one kind of five, so the same move would be a loss rather than a
 * migration. It is cited as the decision that does NOT apply.
 *
 * So this case guards the path rather than exercising a new one. Its seeded
 * defect is the deletion an earlier draft planned: remove the global injection
 * path and a DorkOS-driven session loses the package's commands, agents, hooks
 * and MCP servers, and every assertion below that names one of them reds.
 *
 * The duplicate this leaves is measured, not assumed. A package that is BOTH
 * SDK-injected and user-tier linked was staged for a real `claude` 2.1.266 on
 * 2026-09-09 with a control package injected and never linked
 * (`meta/harness-smoke/20260909-103643.543-claude-user-tier.md`). It listed the
 * shared skill ONCE and the control appeared, so the injection route
 * demonstrably loaded and the two routes collapsed to one target. The design
 * stands and no `sdkInjected` input is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeAgentSdkPluginsArray } from '../messaging/plugin-activation.js';
import { listEnabledPluginNames } from '../../../marketplace/installed-scanner.js';

/** A no-op logger, so a warning never becomes console noise. */
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof buildClaudeAgentSdkPluginsArray>[0]['logger'];

let dorkHome = '';

/**
 * Stage a globally installed package carrying all five kinds injection
 * delivers, exactly as the marketplace installer leaves it on disk.
 */
function installGlobalPackage(name: string): void {
  const dir = join(dorkHome, 'plugins', name);
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(
    join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'plugin', description: name })
  );
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' })
  );

  mkdirSync(join(dir, 'skills', 'greet'), { recursive: true });
  writeFileSync(
    join(dir, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: Say hello\n---\n# greet\n'
  );
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'ship.md'), '---\ndescription: Ship it\n---\nShip.\n');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'helper.md'), '---\nname: helper\n---\nHelp.\n');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } })
  );
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { thing: { command: 'thing-server' } } })
  );
}

beforeEach(() => {
  dorkHome = mkdtempSync(join(tmpdir(), 'no-loss-'));
});

afterEach(() => {
  rmSync(dorkHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('case 10: global SDK injection survives the user tier', () => {
  it('a globally installed package is still activated, and its whole directory is handed to the SDK', async () => {
    installGlobalPackage('globex');

    // The list the runtime reads (`refreshActivatedPlugins` calls exactly this).
    const enabled = await listEnabledPluginNames(dorkHome);
    expect(enabled).toContain('globex');

    // The array the runtime hands `query()`. Seeded defect: delete the global
    // injection path, and this is empty.
    const plugins = await buildClaudeAgentSdkPluginsArray({
      dorkHome,
      enabledPluginNames: enabled,
      logger,
    });
    expect(plugins).toEqual([{ type: 'local', path: join(dorkHome, 'plugins', 'globex') }]);
  });

  it('the entry is the package ROOT, which is what carries all five kinds', async () => {
    // The claim this case exists for, named kind by kind. The SDK auto-loads
    // skills, commands, agents, hooks and MCP servers from the directory it is
    // given, so pointing the entry at `skills/` — the one kind the user tier
    // delivers — would drop the other four without failing anything else.
    installGlobalPackage('globex');
    const plugins = await buildClaudeAgentSdkPluginsArray({
      dorkHome,
      enabledPluginNames: await listEnabledPluginNames(dorkHome),
      logger,
    });

    const root = plugins[0]?.path ?? '';
    expect(root).toBe(join(dorkHome, 'plugins', 'globex'));
    for (const kind of ['skills', 'commands', 'agents', 'hooks', '.mcp.json']) {
      expect(join(root, kind).startsWith(root), `${kind} is under the injected root`).toBe(true);
    }
    expect(root.endsWith('skills')).toBe(false);
  });

  it('injection is unaffected by whether the user tier linked the same package', async () => {
    // The user tier writes symlinks into two folders in a HOME directory and
    // touches nothing under `<dorkHome>/plugins`, which is the only thing this
    // path reads. A session DorkOS drives is therefore served exactly as it was
    // before the slice, whatever somebody has shared with.
    installGlobalPackage('globex');
    const before = await buildClaudeAgentSdkPluginsArray({
      dorkHome,
      enabledPluginNames: await listEnabledPluginNames(dorkHome),
      logger,
    });

    const home = mkdtempSync(join(tmpdir(), 'no-loss-home-'));
    try {
      const { projectGlobal } = await import('@dorkos/harness');
      const { applyGlobalPlan } = await import('@dorkos/harness');
      const roots = {
        dorkHome,
        agentsSkillsDir: join(home, '.agents', 'skills'),
        claudeSkillsDir: join(home, '.claude', 'skills'),
      };
      applyGlobalPlan(projectGlobal({ roots, harnesses: ['codex', 'claude-code'] }), roots, {
        sweepOrphans: true,
      });

      const after = await buildClaudeAgentSdkPluginsArray({
        dorkHome,
        enabledPluginNames: await listEnabledPluginNames(dorkHome),
        logger,
      });
      expect(after).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
