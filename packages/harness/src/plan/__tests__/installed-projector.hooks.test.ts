import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { pluginDataText, pluginEnvPrefix, projectedHooks } from '../installed-projector.js';
import { getActionContent } from '../content-map.js';
import type { InstalledPlugin, ProjectInstalledPlugin } from '../../sources/installed.js';
import { MANIFEST, emptyRepo, projectPlugin } from './installed-projector.fixtures.js';

describe('buildPlan hook gate (DOR-522)', () => {
  /** Every command string the plan would write into any harness's hook config. */
  function plannedCommands(plan: ReturnType<typeof buildPlan>): string[] {
    const out: string[] = [];
    for (const action of plan.actions) {
      if (action.artifact !== 'hook') continue;
      const content = getActionContent(action);
      if (content) out.push(content);
    }
    return out;
  }

  it('HK-07: withholds a disallowed package from BOTH the settings merge and the generated hook files', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
        allowPluginHooks: () => false,
      });
      expect(plannedCommands(plan).join('\n')).not.toContain('echo from-plugin');
      // The rest of the package still projects: the gate is on hooks alone.
      expect(plan.actions.some((a) => a.artifact === 'skill' && a.name === 'acme__alpha')).toBe(
        true
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('HK-07: projects the same package once it is allowed', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
        allowPluginHooks: (name) => name === 'acme',
      });
      expect(plannedCommands(plan).join('\n')).toContain('echo from-plugin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('HK-07: gates per package, not all-or-nothing', () => {
    const repo = emptyRepo();
    const other: ProjectInstalledPlugin = {
      ...projectPlugin,
      name: 'other',
      location: { scope: 'project', relDir: '.dork/plugins/other' },
      skills: [],
      commands: [],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-other' }] }] },
    };
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin, other],
        allowPluginHooks: (name) => name === 'other',
      });
      const commands = plannedCommands(plan).join('\n');
      expect(commands).toContain('echo from-other');
      expect(commands).not.toContain('echo from-plugin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('HK-09: reports a package’s unreadable hooks whether or not the gate allows it (DOR-1724)', () => {
    // This used to take only the ALLOWED packages, on the reasoning that a
    // withheld package contributes nothing so its salvage losses are noise. That
    // had it backwards: the loss happens at READ time, before consent is a
    // question, and both the approval card and the CLI's withheld block list
    // what the reader could recover — so a person decided whether to trust the
    // package from a list that silently omitted the part that would not parse,
    // and heard about it only after saying yes (DOR-1849).
    const repo = emptyRepo();
    const rotted: InstalledPlugin = {
      ...projectPlugin,
      unreadableHooks: [
        { path: '.dork/plugins/acme/hooks/hooks.json', event: 'Stop', total: true },
      ],
    };
    try {
      const gated = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [rotted],
        allowPluginHooks: () => false,
      });
      const expected = [
        {
          artifact: 'hook',
          harness: 'claude-code',
          // The harness is a placeholder: the loss happened at read time, ahead
          // of every harness, so no filter may hide it (contract VC-02).
          harnessAgnostic: true,
          name: 'acme:Stop',
          // The declaring file, so the completeness check can match this warning
          // to the source it is about (DOR-1845).
          source: '.dork/plugins/acme/hooks/hooks.json',
          reason:
            '.dork/plugins/acme/hooks/hooks.json declares "Stop" in a shape this reader cannot use, so the whole event was dropped and no "Stop" hook is projected',
        },
      ];
      expect(gated.warnings.filter((w) => w.artifact === 'hook')).toEqual(expected);

      // …and says exactly the same thing when the package IS allowed. The
      // sentence is about the file, so the gate does not change a word of it.
      const allowed = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [rotted],
        allowPluginHooks: () => true,
      });
      expect(allowed.warnings.filter((w) => w.artifact === 'hook')).toEqual(expected);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('${CLAUDE_PLUGIN_DATA} (DOR-2245)', () => {
  const dataPlugin: ProjectInstalledPlugin = {
    ...projectPlugin,
    commands: [
      {
        name: 'save',
        sourcePath: '.dork/plugins/acme/commands/save.md',
        content: '---\ndescription: s\n---\nWrite to `${CLAUDE_PLUGIN_DATA}/state.json`.\n',
      },
    ],
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs" "${CLAUDE_PLUGIN_DATA}/log"',
            },
          ],
        },
      ],
    },
  };

  // Purpose: a command a plugin wrote for Claude Code's data dir points at the
  // install's own .dork/data once projected, never at an unset variable.
  it('rewrites the data token in command wrappers to <install>/.dork/data', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [dataPlugin],
      });
      const wrapper = plan.actions.find((a) => a.target === '.claude/commands/acme/save.md');
      const content = getActionContent(wrapper!)!;
      const data = pluginDataText(join(repo, '.dork/plugins/acme'), process.platform);
      expect(content).toContain(`${data}/state.json`);
      expect(content).not.toContain('${CLAUDE_PLUGIN_DATA}');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Purpose: the prefix is DorkOS's own addition, not the package's command, so
  // it never enters the consent digest; a package already approved stays approved.
  it('keeps the export prefix out of what a person is asked to approve', () => {
    const [entry] = projectedHooks([dataPlugin], '/repo');
    expect(entry.hooks[0].command).toBe(
      'node "/repo/.dork/plugins/acme/hooks/x.mjs" "/repo/.dork/plugins/acme/.dork/data/log"'
    );
  });

  // Purpose: the prefix survives a path with a quote in it, and a real shell
  // then sees exactly the two paths. Needs /bin/sh, which Windows runners lack
  // (Claude Code there runs hooks through Git Bash, not this path).
  it.skipIf(process.platform === 'win32')(
    'quotes the prefix so a real shell exports the exact paths',
    () => {
      const installDir = "/tmp/o'brien/.dork/plugins/acme";
      const out = execFileSync('/bin/sh', [
        '-c',
        `${pluginEnvPrefix(installDir, 'darwin')}printf '%s|%s' "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA"`,
      ]).toString();
      expect(out).toBe(`${installDir}|${installDir}/.dork/data`);
    }
  );
});
