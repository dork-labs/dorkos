import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { pluginHookReach } from '../hooks-projection.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import type { ClaudeHooksConfig } from '../../generate/hooks.js';
import type { InstalledPlugin } from '../../sources/installed.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const claudeHooks: ClaudeHooksConfig = {
  Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
};

/** A repo with one authored skill, so a plan has something ordinary to say too. */
function fixtureRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-hookpolicy-'));
  mkdirSync(join(d, '.agents', 'skills', 'demo'), { recursive: true });
  writeFileSync(join(d, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n');
  return d;
}

/** One project-scoped plugin that declares a hook, so the claude-code merge has a source. */
function pluginWithHooks(): InstalledPlugin {
  return {
    name: 'p',
    type: 'plugin',
    scope: 'project',
    relDir: '.dork/plugins/p',
    layers: ['hooks'],
    skills: [],
    commands: [],
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo plugin' }] }] },
  };
}

function planFor(hookPolicies: unknown[], harnesses: string[], plugins: InstalledPlugin[] = []) {
  const manifest = parseHarnessManifest({ version: 1, harnesses, hookPolicies });
  return buildPlan({
    repoRoot: dir,
    manifest,
    claudeHooks,
    agentsMdExists: true,
    installedPlugins: plugins,
  });
}

describe('manifest hookPolicies', () => {
  it('HK-15: honours projection none: nothing is generated for that harness, and each source drops', () => {
    // The headline. Until DOR-1858 a `none` policy was validated and ignored, so
    // the engine generated `.cursor/hooks.json` for a manifest that said not to.
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'cursor', projection: 'none' }], ['claude-code', 'cursor']);

    expect(plan.actions.some((a) => a.harness === 'cursor' && a.artifact === 'hook')).toBe(false);
    const drop = plan.drops.find((a) => a.harness === 'cursor' && a.artifact === 'hook');
    expect(drop?.source).toBe('.claude/settings.json');
    expect(drop?.reason).toBe(
      "hooks are not projected to Cursor — your manifest's hookPolicies says none"
    );
  });

  it('HK-15: honours projection generate: the harness keeps its generated hooks file', () => {
    // `generate` is what the engine already does for Codex, so saying it changes nothing.
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'codex', projection: 'generate' }], ['claude-code', 'codex']);

    const gen = plan.actions.find(
      (a) => a.harness === 'codex' && a.artifact === 'hook' && a.kind === 'generate'
    );
    expect(gen?.target).toBe('.codex/hooks.json');
    expect(plan.drops.some((a) => a.harness === 'codex' && a.name === 'hooks')).toBe(false);
  });

  it('HK-15: honours projection native on a harness that has no native hooks read path', () => {
    // Codex does not read `.claude/settings.json`; a manifest claiming it does gets
    // nothing written and a drop that says what Codex really reads.
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'codex', projection: 'native' }], ['claude-code', 'codex']);

    expect(plan.actions.some((a) => a.harness === 'codex' && a.artifact === 'hook')).toBe(false);
    const drop = plan.drops.find((a) => a.harness === 'codex' && a.artifact === 'hook');
    expect(drop?.reason).toContain("your manifest's hookPolicies says native");
    expect(drop?.reason).toContain('.codex/hooks.json');
    expect(drop?.reason).toContain('learn.chatgpt.com/docs/hooks');
  });

  it('HK-15: names the harness own hooks file when vendor-facts has no cell for it', () => {
    // Cursor has no `hooks` row in the vendor-facts table, so the reason names the
    // file DorkOS would write rather than inventing a vendor claim.
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'cursor', projection: 'native' }], ['claude-code', 'cursor']);

    const drop = plan.drops.find((a) => a.harness === 'cursor' && a.artifact === 'hook');
    expect(drop?.reason).toContain('.cursor/hooks.json');
    expect(drop?.reason).not.toContain('read 20');
  });

  it('HK-15: changes nothing when the manifest carries no policy for a harness', () => {
    // The default. An existing manifest with no hookPolicies block projects exactly
    // as it did before.
    dir = fixtureRepo();
    const withPolicy = planFor([{ tool: 'codex', projection: 'generate' }], ['codex']);
    const without = planFor([], ['codex']);

    expect(without.actions.map((a) => `${a.kind}:${a.artifact}:${a.name}`)).toEqual(
      withPolicy.actions.map((a) => `${a.kind}:${a.artifact}:${a.name}`)
    );
    expect(without.drops).toEqual(withPolicy.drops);
  });

  it('HK-15: keeps Claude Code reading its own settings file under a none policy', () => {
    // `none` turns off what the ENGINE writes. It cannot turn off Claude Code
    // reading `.claude/settings.json`, so claiming those hooks were dropped would
    // be false — this repo's own manifest says `none` for claude-code and means
    // exactly "nothing is projected; Claude reads its own file".
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'claude-code', projection: 'none' }], ['claude-code']);

    const native = plan.actions.find(
      (a) => a.harness === 'claude-code' && a.artifact === 'hook' && a.kind === 'native'
    );
    expect(native?.source).toBe('.claude/settings.json');
    expect(
      plan.drops.some((a) => a.harness === 'claude-code' && a.source === '.claude/settings.json')
    ).toBe(false);
  });

  it('HK-15: stops merging installed-plugin hooks into Claude Code under a none policy', () => {
    // The one engine WRITE aimed at Claude Code is the `.claude/settings.local.json`
    // merge, so that is what `none` switches off — with a drop naming the package.
    dir = fixtureRepo();
    const plugins = [pluginWithHooks()];
    const on = planFor([], ['claude-code'], plugins);
    expect(on.actions.some((a) => a.kind === 'merge' && a.artifact === 'hook')).toBe(true);

    const off = planFor([{ tool: 'claude-code', projection: 'none' }], ['claude-code'], plugins);
    expect(off.actions.some((a) => a.kind === 'merge' && a.artifact === 'hook')).toBe(false);
    const drop = off.drops.find((a) => a.harness === 'claude-code' && a.name === 'plugin-hooks');
    expect(drop?.source).toBe('.dork/plugins/p/hooks/hooks.json');
    expect(drop?.reason).toBe(
      "hooks are not projected to Claude Code — your manifest's hookPolicies says none"
    );
  });

  it('HK-15: warns when a policy asks for a hooks file the engine cannot write', () => {
    // OpenCode has no declarative hook config at all, so `generate` is a request
    // nothing can satisfy. The drop stays honest; the warning names the key.
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'opencode', projection: 'generate' }], ['opencode']);

    const warning = plan.warnings.find((w) => w.harness === 'opencode' && w.artifact === 'hook');
    expect(warning?.reason).toContain('hookPolicies');
    expect(warning?.reason).toContain('generate');
    expect(plan.drops.some((a) => a.harness === 'opencode' && a.artifact === 'hook')).toBe(true);
  });

  it('HK-15: warns when a policy claims a harness reads the canonical file and it does not', () => {
    // Gemini reads no `.claude/settings.json`; the drop already says why its hooks
    // do not travel, and the warning says the manifest line is wrong.
    dir = fixtureRepo();
    const plan = planFor([{ tool: 'gemini', projection: 'native' }], ['gemini']);

    const warning = plan.warnings.find((w) => w.harness === 'gemini' && w.artifact === 'hook');
    expect(warning?.reason).toContain('hookPolicies');
    expect(warning?.reason).toContain('.claude/settings.json');
  });

  it('HK-15: says nothing about hook policies in a repo with no hooks at all', () => {
    // No hooks means no artifact, so no harness gets a line — policy or not.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({
      version: 1,
      harnesses: ['claude-code', 'cursor'],
      hookPolicies: [{ tool: 'cursor', projection: 'none' }],
    });
    const plan = buildPlan({ repoRoot: dir, manifest, agentsMdExists: true });

    expect(plan.actions.some((a) => a.artifact === 'hook')).toBe(false);
    expect(plan.drops.some((a) => a.artifact === 'hook')).toBe(false);
    expect(plan.warnings.some((w) => w.artifact === 'hook')).toBe(false);
  });
});

describe('retired manifest keys', () => {
  it('VC-10: project identically to a manifest that does not carry them', () => {
    // The four keys DOR-1858 retired are accepted and IGNORED. "Ignored" has to
    // mean the plan is the same object either way, not merely that the file
    // parses — the whole point is that nothing downstream reads them.
    dir = fixtureRepo();
    const shape = { version: 1, harnesses: ['claude-code', 'codex'] };
    const plain = buildPlan({
      repoRoot: dir,
      manifest: parseHarnessManifest(shape),
      claudeHooks,
      agentsMdExists: true,
    });
    const carried = buildPlan({
      repoRoot: dir,
      manifest: parseHarnessManifest({
        ...shape,
        skillWrappers: [{ target: 'codex', name: 'x', anything: true }],
        commandMappings: 'not even an array',
        instructionProjections: null,
        skillBundles: [{ name: 'flow', skills: [{ name: 'a' }] }],
      }),
      claudeHooks,
      agentsMdExists: true,
    });

    expect(carried).toEqual(plain);
  });
});

describe('pluginHookReach', () => {
  const reach = (harnesses: string[], hookPolicies: unknown[] = []) =>
    pluginHookReach(parseHarnessManifest({ version: 1, harnesses, hookPolicies }));

  it('HK-15: reports every enabled harness an installed package can reach', () => {
    // The default: nothing suppressed, so a recorded yes really installs something.
    expect(reach(['claude-code', 'codex'])).toEqual({
      reached: ['claude-code', 'codex'],
      suppressed: [],
    });
  });

  it('HK-15: counts a none policy as suppressed, whichever harness it names', () => {
    expect(reach(['claude-code'], [{ tool: 'claude-code', projection: 'none' }])).toEqual({
      reached: [],
      suppressed: [{ harness: 'claude-code', projection: 'none' }],
    });
    expect(reach(['codex'], [{ tool: 'codex', projection: 'none' }])).toEqual({
      reached: [],
      suppressed: [{ harness: 'codex', projection: 'none' }],
    });
  });

  it('HK-15: counts native as suppressed for a generate harness, and not for Claude Code', () => {
    // `native` on Codex means the engine writes nothing, so a package's hooks do
    // not arrive. On Claude Code `native` IS the default, and the merge runs.
    expect(reach(['codex'], [{ tool: 'codex', projection: 'native' }]).reached).toEqual([]);
    expect(reach(['claude-code'], [{ tool: 'claude-code', projection: 'native' }]).reached).toEqual(
      ['claude-code']
    );
  });

  it('HK-15: blames no manifest line for a harness that could never receive hooks', () => {
    // OpenCode has nowhere to write with or without a policy, so calling it
    // "suppressed" would send somebody to delete a line that changes nothing.
    expect(reach(['opencode'])).toEqual({ reached: [], suppressed: [] });
    expect(reach(['gemini'], [{ tool: 'gemini', projection: 'none' }])).toEqual({
      reached: [],
      suppressed: [],
    });
  });

  it('HK-15: separates the partly-suppressed case from the wholly-suppressed one', () => {
    expect(reach(['claude-code', 'codex'], [{ tool: 'claude-code', projection: 'none' }])).toEqual({
      reached: ['codex'],
      suppressed: [{ harness: 'claude-code', projection: 'none' }],
    });
  });
});

describe('pluginHookReach agrees with the plan', () => {
  // Two readers of one rule: `--allow-hooks` asks `pluginHookReach` whether a
  // package's hooks can land, and the person then reads a plan built by
  // `planHooks`. If they ever disagree, the CLI refuses a yes the plan would
  // have honoured, or records one it would not — so the agreement is asserted
  // over the whole matrix rather than trusted to two similar-looking branches.
  const HARNESSES = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'opencode'] as const;
  const POLICIES = [undefined, 'native', 'generate', 'none'] as const;

  it('HK-15: includes a harness exactly when the plan carries a hooks projection to it', () => {
    dir = fixtureRepo();
    const plugins = [pluginWithHooks()];

    for (const harness of HARNESSES) {
      for (const projection of POLICIES) {
        const manifest = parseHarnessManifest({
          version: 1,
          harnesses: [harness],
          hookPolicies: projection === undefined ? [] : [{ tool: harness, projection }],
        });
        const plan = buildPlan({
          repoRoot: dir,
          manifest,
          claudeHooks,
          agentsMdExists: true,
          installedPlugins: plugins,
        });

        // What the plan really does with this project's hooks for this harness:
        // a generated file, or the merge into the user-owned settings file.
        const projected = plan.actions.some(
          (a) => a.artifact === 'hook' && (a.kind === 'generate' || a.kind === 'merge')
        );
        const reached = pluginHookReach(manifest).reached.includes(harness);

        expect({ harness, projection, reached }).toEqual({
          harness,
          projection,
          reached: projected,
        });
      }
    }
  });
});
