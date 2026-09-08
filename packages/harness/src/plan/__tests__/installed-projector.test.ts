import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { mergeHookConfigs, projectedHooks } from '../installed-projector.js';
import { getActionContent } from '../content-map.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import type { InstalledPlugin } from '../../sources/installed.js';

const MANIFEST = parseHarnessManifest({
  version: 1,
  harnesses: ['claude-code', 'codex', 'cursor'],
});

/** An empty repo root (no authored skills / AGENTS.md) so only installed projections show. */
function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'harness-instproj-'));
}

const projectPlugin: InstalledPlugin = {
  name: 'acme',
  type: 'plugin',
  scope: 'project',
  relDir: '.dork/plugins/acme',
  skills: [
    {
      name: 'alpha',
      sourceDir: '.dork/plugins/acme/skills/alpha',
      usesPluginRoot: false,
      hasSchedule: false,
    },
    {
      name: 'beta',
      sourceDir: '.dork/plugins/acme/.dork/tasks/beta',
      usesPluginRoot: false,
      hasSchedule: false,
    },
  ],
  commands: [
    {
      name: 'capture',
      sourcePath: '.dork/plugins/acme/commands/capture.md',
      content: '---\ndescription: cap\n---\nRead `${CLAUDE_PLUGIN_ROOT}/skills/x/SKILL.md`.\n',
    },
  ],
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-plugin' }] }] },
  layers: ['commands', 'skills', 'tasks', 'hooks', 'extensions', 'mcp-servers'],
};

describe('installed-plugin projection via buildPlan', () => {
  it('symlinks installed skills into both the Claude Code and Codex skill dirs (namespaced)', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });

      const codexSkills = plan.actions.filter(
        (a) => a.provenance === 'installed' && a.harness === 'codex' && a.kind === 'symlink'
      );
      expect(codexSkills.map((a) => a.target)).toEqual([
        '.agents/skills/acme__alpha',
        '.agents/skills/acme__beta',
      ]);
      expect(codexSkills.map((a) => a.source)).toEqual([
        '.dork/plugins/acme/skills/alpha',
        '.dork/plugins/acme/.dork/tasks/beta',
      ]);

      // Claude Code gets its OWN namespaced symlinks now (no SDK activation).
      const claudeSkills = plan.actions.filter(
        (a) => a.provenance === 'installed' && a.harness === 'claude-code' && a.kind === 'symlink'
      );
      expect(claudeSkills.map((a) => a.target)).toEqual([
        '.claude/skills/acme__alpha',
        '.claude/skills/acme__beta',
      ]);
      // Nothing about the PLUGIN is native — it reaches Claude Code and Codex as
      // projected files, never as an SDK activation. (Cursor takes the SKILLS
      // native off the `.agents/skills` link, which is the row above; the check
      // is scoped to the plugin-level artifact so it still means what it says.)
      expect(
        plan.actions.some(
          (a) => a.provenance === 'installed' && a.kind === 'native' && a.artifact === 'plugin'
        )
      ).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('generates repo-local command wrappers for Claude Code with the token rewritten to absolute', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });

      const wrapper = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.claude/commands/acme/capture.md'
      );
      expect(wrapper).toBeDefined();
      const content = getActionContent(wrapper!)!;
      // Token rewritten to the absolute install dir; no bare token remains.
      expect(content).toContain(join(repo, '.dork/plugins/acme', 'skills/x/SKILL.md'));
      expect(content).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      // Frontmatter preserved as the first bytes; marker inserted right after it.
      expect(content.startsWith('---\ndescription: cap\n---\n')).toBe(true);
      expect(content).toContain('dorkos:generated-command');

      // A self-ignoring .gitignore is generated beside the wrappers.
      const gitignore = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.claude/commands/acme/.gitignore'
      );
      expect(getActionContent(gitignore!)).toContain('*');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('names each harness’s own command format on an installed-command drop (CM-06)', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const drop = plan.drops.find(
        (d) =>
          d.provenance === 'installed' &&
          d.artifact === 'command' &&
          d.harness === 'codex' &&
          d.name === 'acme:commands'
      );
      // Codex is the one harness with genuinely no repo-local command format:
      // its custom prompts were deprecated in favour of skills. The other
      // harnesses' drops now name their own format instead (CM-06).
      expect(drop?.reason).toMatch(/no repo-local slash-command format/);
      // Cursor is in this manifest too, and gets the honest reason — asserted
      // here rather than left to the authored half, because the installed drop
      // is a separate call site that shared the same stale sentence.
      const cursorDrop = plan.drops.find(
        (d) => d.provenance === 'installed' && d.artifact === 'command' && d.harness === 'cursor'
      );
      expect(cursorDrop?.reason).toContain('.cursor/commands/*.md');
      expect(cursorDrop?.reason).not.toMatch(/no repo-local slash-command format/);
      // The `commands` layer is NOT reported as a non-portable-layer drop anymore.
      // `reason` is optional on ProjectionAction (required only by convention for
      // drops), so it is narrowed rather than asserted — an absent reason cannot
      // mention a layer either, so the `false` expectation is unchanged.
      expect(
        plan.drops.some((d) => d.name === 'acme:commands' && d.reason?.includes('layer'))
      ).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('merges installed-plugin hooks into .claude/settings.local.json for Claude Code', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const merge = plan.actions.find(
        (a) => a.kind === 'merge' && a.target === '.claude/settings.local.json'
      );
      expect(merge).toBeDefined();
      expect(merge?.harness).toBe('claude-code');
      expect(getActionContent(merge!)).toContain('echo from-plugin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('warns when a projected installed skill still references ${CLAUDE_PLUGIN_ROOT}', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [
          {
            ...projectPlugin,
            skills: [
              {
                name: 'alpha',
                sourceDir: '.dork/plugins/acme/skills/alpha',
                usesPluginRoot: true,
                hasSchedule: false,
              },
            ],
          },
        ],
      });
      const warning = plan.warnings.find((w) => w.artifact === 'skill' && w.name === 'acme__alpha');
      expect(warning).toBeDefined();
      expect(warning?.reason).toContain('${CLAUDE_PLUGIN_ROOT}');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('namespaces installed skills so they never collide with an authored skill of the same name', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [
          {
            ...projectPlugin,
            skills: [
              {
                name: 'alpha',
                sourceDir: '.dork/plugins/acme/skills/alpha',
                usesPluginRoot: false,
                hasSchedule: false,
              },
            ],
          },
        ],
      });
      const claudeTarget = plan.actions.find(
        (a) => a.provenance === 'installed' && a.kind === 'symlink' && a.harness === 'claude-code'
      )?.target;
      // Installed `alpha` is `acme__alpha` — distinct from an authored `.claude/skills/alpha`.
      expect(claudeTarget).toBe('.claude/skills/acme__alpha');
      expect(claudeTarget).not.toBe('.claude/skills/alpha');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('drops non-portable layers with reasons, and no longer drops a harness that reads .agents/skills', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const dropNames = plan.drops.filter((d) => d.provenance === 'installed').map((d) => d.name);
      // extensions + mcp-servers are non-portable; skills/tasks/hooks/commands are NOT layer-dropped.
      expect(dropNames).toContain('acme:extensions');
      expect(dropNames).toContain('acme:mcp-servers');
      expect(dropNames).not.toContain('acme:skills');
      expect(dropNames).not.toContain('acme:hooks');
      // Cursor used to get one whole-plugin drop ("not auto-projected to cursor
      // in v1; see DOR-143"). It reads `.agents/skills` natively, and the link
      // there is now planned whatever harnesses are enabled, so the honest answer
      // is a per-skill `native` and no drop at all (SK-05).
      expect(
        plan.drops.filter(
          (d) => d.provenance === 'installed' && d.harness === 'cursor' && d.name === 'acme'
        )
      ).toEqual([]);
      expect(
        plan.actions
          .filter(
            (a) => a.provenance === 'installed' && a.harness === 'cursor' && a.artifact === 'skill'
          )
          .map((a) => ({ kind: a.kind, name: a.name }))
      ).toEqual([
        { kind: 'native', name: 'acme__alpha' },
        { kind: 'native', name: 'acme__beta' },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scope mapping: a global install is dropped, never projected into project dirs', () => {
    const repo = emptyRepo();
    try {
      const globalPlugin: InstalledPlugin = {
        name: 'globex',
        type: 'plugin',
        scope: 'global',
        skills: [],
        commands: [],
        layers: ['skills'],
      };
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [globalPlugin, projectPlugin],
      });

      // The project plugin projects; the global plugin never produces a project-dir action.
      expect(plan.actions.some((a) => a.name.startsWith('globex'))).toBe(false);
      expect(plan.actions.some((a) => a.target?.includes('globex'))).toBe(false);
      const globalDrop = plan.drops.find((d) => d.name === 'globex');
      expect(globalDrop?.reason).toMatch(/global-scope/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('folds installed-plugin hooks into the generated Codex hooks file', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST,
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
      const codexHooks = plan.actions.find(
        (a) => a.kind === 'generate' && a.target === '.codex/hooks.json'
      );
      expect(codexHooks).toBeDefined();
      expect(getActionContent(codexHooks!)).toContain('echo from-plugin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('mergeHookConfigs', () => {
  it('concatenates matcher groups per event and ignores undefined inputs', () => {
    const merged = mergeHookConfigs([
      { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] },
      undefined,
      {
        Stop: [{ hooks: [{ type: 'command', command: 'b' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'c' }] }],
      },
    ]);
    expect(merged.Stop).toHaveLength(2);
    expect(merged.PreToolUse).toHaveLength(1);
  });

  it('returns an empty config when nothing has hooks', () => {
    expect(mergeHookConfigs([undefined, undefined])).toEqual({});
  });

  it('defensively skips a non-array event value rather than crashing the spread', () => {
    const merged = mergeHookConfigs([
      // A malformed config that slipped past validation: `Bad` is not an array.
      { Bad: { type: 'command' } as unknown as [] },
      { Stop: [{ hooks: [{ type: 'command', command: 'ok' }] }] },
    ]);
    expect(merged).not.toHaveProperty('Bad');
    expect(merged.Stop).toHaveLength(1);
  });
});

describe('projectedHooks', () => {
  it('reports each command with the event and matcher that fire it, plugin root resolved', () => {
    const plugin: InstalledPlugin = {
      ...projectPlugin,
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo two' }] }],
      },
    };
    expect(projectedHooks([plugin], '/repo')).toEqual([
      {
        packageName: 'acme',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash', command: 'echo two' },
          { event: 'Stop', command: 'node "/repo/.dork/plugins/acme/hooks/x.mjs"' },
        ],
      },
    ]);
  });

  it('distinguishes the same command on two different events', () => {
    // The whole reason the event travels with the command: `echo one` on `Stop`
    // runs when a turn finishes, and on `PreToolUse` before every tool call.
    const onStop = projectedHooks(
      [
        {
          ...projectPlugin,
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo one' }] }] },
        },
      ],
      '/repo'
    );
    const onPreToolUse = projectedHooks(
      [
        {
          ...projectPlugin,
          hooks: {
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo one' }] }],
          },
        },
      ],
      '/repo'
    );
    expect(onStop).not.toEqual(onPreToolUse);
  });

  it('is order-insensitive, so a reordered hooks.json produces an identical list', () => {
    const a = projectedHooks(
      [
        {
          ...projectPlugin,
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'echo a' },
                  { type: 'command', command: 'echo b' },
                ],
              },
            ],
          },
        },
      ],
      '/repo'
    );
    const b = projectedHooks(
      [
        {
          ...projectPlugin,
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'echo b' },
                  { type: 'command', command: 'echo a' },
                ],
              },
            ],
          },
        },
      ],
      '/repo'
    );
    expect(a).toEqual(b);
  });

  it('omits a package with no hooks', () => {
    expect(projectedHooks([{ ...projectPlugin, hooks: undefined }], '/repo')).toEqual([]);
  });

  it('omits what buildPlan would never project: global scope and non-portable types', () => {
    const global: InstalledPlugin = {
      name: 'global-pkg',
      type: 'plugin',
      scope: 'global',
      skills: [],
      commands: [],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo global' }] }] },
      layers: ['hooks'],
    };
    const shape: InstalledPlugin = { ...projectPlugin, name: 'a-shape', type: 'shape' };
    expect(projectedHooks([global, shape], '/repo')).toEqual([]);
  });
});

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

  it('withholds a disallowed package from BOTH the settings merge and the generated hook files', () => {
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

  it('projects the same package once it is allowed', () => {
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

  it('gates per package, not all-or-nothing', () => {
    const repo = emptyRepo();
    const other: InstalledPlugin = {
      ...projectPlugin,
      name: 'other',
      relDir: '.dork/plugins/other',
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

  it('reports a package’s unreadable hooks whether or not the gate allows it (DOR-1724)', () => {
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

describe('installed plugin skills reach the watched skills root (DOR-1518, DOR-1847)', () => {
  /** The manifest a stock project has: Claude Code only, which never sees `.agents/skills`. */
  const CLAUDE_ONLY = parseHarnessManifest({ version: 1, harnesses: ['claude-code'] });

  /** A plugin shipping one scheduled skill and one ordinary one (the flow plugin's shape). */
  const withScheduledSkill: InstalledPlugin = {
    ...projectPlugin,
    commands: [],
    skills: [
      {
        name: 'drain',
        sourceDir: '.dork/plugins/acme/skills/drain',
        usesPluginRoot: false,
        hasSchedule: true,
      },
      {
        name: 'alpha',
        sourceDir: '.dork/plugins/acme/skills/alpha',
        usesPluginRoot: false,
        hasSchedule: false,
      },
    ],
  };

  /** Every planned symlink target, in plan order. */
  function symlinkTargets(plan: ReturnType<typeof buildPlan>): string[] {
    return plan.actions
      .filter((a) => a.provenance === 'installed' && a.kind === 'symlink')
      .map((a) => a.target as string);
  }

  it('links a scheduled skill into .agents/skills even when only claude-code is enabled', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: CLAUDE_ONLY,
        agentsMdExists: false,
        installedPlugins: [withScheduledSkill],
      });

      const link = plan.actions.find((a) => a.target === '.agents/skills/acme__drain');
      expect(link).toBeDefined();
      expect(link?.kind).toBe('symlink');
      expect(link?.source).toBe('.dork/plugins/acme/skills/drain');
      expect(link?.provenance).toBe('installed');
      // The note that explains why a link exists in a directory no enabled
      // harness reads. That it REACHES the operator is pinned separately, on the
      // CLI report itself (`packages/cli/src/__tests__/harness-sync.test.ts`).
      expect(link?.reason).toContain('scheduler');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('links an UNSCHEDULED plugin skill there too, with the reason that applies to it', () => {
    // This was the opposite assertion until DOR-1847: `alpha` has no schedule,
    // so nothing linked it into `.agents/skills` and an OpenCode-, Cursor-,
    // Gemini- or Copilot-only project never saw it. The link is unconditional
    // now; only the REASON differs between a scheduled skill and an ordinary one.
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: CLAUDE_ONLY,
        agentsMdExists: false,
        installedPlugins: [withScheduledSkill],
      });

      expect(symlinkTargets(plan)).toContain('.claude/skills/acme__alpha');
      expect(symlinkTargets(plan)).toContain('.agents/skills/acme__alpha');

      const scheduled = plan.actions.find((a) => a.target === '.agents/skills/acme__drain');
      const ordinary = plan.actions.find((a) => a.target === '.agents/skills/acme__alpha');
      expect(scheduled?.reason).toContain('scheduler');
      expect(ordinary?.reason).not.toContain('scheduler');
      expect(ordinary?.reason).toContain('.agents/skills');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('plans the .agents/skills link exactly once when codex is also enabled', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: MANIFEST, // claude-code + codex + cursor
        agentsMdExists: false,
        installedPlugins: [withScheduledSkill],
      });

      // Codex's own per-harness rule already links it; the scheduler rule stands
      // down rather than planning the same target a second time.
      expect(symlinkTargets(plan).filter((t) => t === '.agents/skills/acme__drain')).toHaveLength(
        1
      );
      // And the harness rule still covers the unscheduled skill, as before.
      expect(symlinkTargets(plan)).toContain('.agents/skills/acme__alpha');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('warns about an unresolved plugin-root token in a scheduled skill it links', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: CLAUDE_ONLY,
        agentsMdExists: false,
        installedPlugins: [
          {
            ...withScheduledSkill,
            skills: [
              {
                name: 'drain',
                sourceDir: '.dork/plugins/acme/skills/drain',
                usesPluginRoot: true,
                hasSchedule: true,
              },
            ],
          },
        ],
      });

      const warned = plan.warnings.filter(
        (w) => w.name === 'acme__drain' && w.reason.includes('${CLAUDE_PLUGIN_ROOT}')
      );
      // One for the Claude Code projection, one for the scheduler link.
      expect(warned).toHaveLength(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('installed skills reach .agents/skills whatever harnesses are enabled (SK-05)', () => {
  /** Every planned symlink target for installed content, in plan order. */
  function installedLinks(plan: ReturnType<typeof buildPlan>): string[] {
    return plan.actions
      .filter((a) => a.provenance === 'installed' && a.kind === 'symlink')
      .map((a) => a.target as string);
  }

  /** Plan `projectPlugin` against one harness set. */
  function planFor(harnesses: string[]): ReturnType<typeof buildPlan> {
    const repo = emptyRepo();
    try {
      return buildPlan({
        repoRoot: repo,
        manifest: parseHarnessManifest({ version: 1, harnesses }),
        agentsMdExists: false,
        installedPlugins: [projectPlugin],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  it('links them for an opencode-only project, and says so on the native action', () => {
    // Reproduced 2026-09-07: with `harnesses: ['opencode']` the plan claimed
    // `native` "via the Codex namespaced symlink" while nothing linked the
    // directory at all, so the skills reached nobody.
    const plan = planFor(['opencode']);

    expect(installedLinks(plan)).toEqual([
      '.agents/skills/acme__alpha',
      '.agents/skills/acme__beta',
    ]);
    const natives = plan.actions.filter(
      (a) => a.provenance === 'installed' && a.harness === 'opencode' && a.artifact === 'skill'
    );
    expect(natives).toHaveLength(2);
    for (const action of natives) {
      expect(action.kind).toBe('native');
      expect(action.reason).toContain(`.agents/skills/${action.name}`);
    }
  });

  it('links them for a cursor-only project, which used to be a whole-plugin drop', () => {
    const plan = planFor(['cursor']);

    expect(installedLinks(plan)).toEqual([
      '.agents/skills/acme__alpha',
      '.agents/skills/acme__beta',
    ]);
    const natives = plan.actions.filter(
      (a) => a.provenance === 'installed' && a.harness === 'cursor' && a.artifact === 'skill'
    );
    expect(natives.map((a) => a.name)).toEqual(['acme__alpha', 'acme__beta']);
    expect(natives.every((a) => a.kind === 'native')).toBe(true);
    // No whole-plugin drop for a harness that reads the directory just fine.
    expect(
      plan.drops.filter(
        (d) => d.provenance === 'installed' && d.harness === 'cursor' && d.name === 'acme'
      )
    ).toEqual([]);
  });

  it('links them for a claude-code-only project too, beside its own .claude/skills links', () => {
    // Unconditional: `.agents/skills` is the one directory five harnesses read,
    // so a package's skills are there whether or not one of them is enabled today.
    const plan = planFor(['claude-code']);

    expect(installedLinks(plan)).toEqual([
      '.claude/skills/acme__alpha',
      '.claude/skills/acme__beta',
      '.agents/skills/acme__alpha',
      '.agents/skills/acme__beta',
    ]);
  });

  it('plans each .agents/skills link exactly once when codex is enabled as well', () => {
    const plan = planFor(['claude-code', 'codex', 'opencode']);
    const links = installedLinks(plan);
    expect(links.filter((t) => t === '.agents/skills/acme__alpha')).toHaveLength(1);
    expect(links.filter((t) => t === '.agents/skills/acme__beta')).toHaveLength(1);
  });

  it('warns once per unlinked-token skill per plan, never twice for the same link', () => {
    const repo = emptyRepo();
    try {
      const plan = buildPlan({
        repoRoot: repo,
        manifest: parseHarnessManifest({ version: 1, harnesses: ['opencode'] }),
        agentsMdExists: false,
        installedPlugins: [
          {
            ...projectPlugin,
            skills: [
              {
                name: 'alpha',
                sourceDir: '.dork/plugins/acme/skills/alpha',
                usesPluginRoot: true,
                hasSchedule: false,
              },
            ],
          },
        ],
      });
      // One for the opencode native projection, one for the canonical link.
      expect(
        plan.warnings.filter(
          (w) => w.name === 'acme__alpha' && w.reason.includes('${CLAUDE_PLUGIN_ROOT}')
        )
      ).toHaveLength(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
