import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { getActionContent } from '../content-map.js';
import { parseHarnessManifest, HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import type { DetectedHarness, ProjectionPlan } from '../types.js';
import { GENERATED_HOOKS_DESCRIPTION, type ClaudeHooksConfig } from '../../generate/hooks.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const claudeHooks: ClaudeHooksConfig = {
  Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
};

function fixtureRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-proj-'));
  mkdirSync(join(d, '.agents', 'skills', 'demo'), { recursive: true });
  writeFileSync(join(d, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n');
  return d;
}

/**
 * A plan over `fixtureRepo()` that HAS authored commands to talk about.
 *
 * Since DOR-1847 a repo with no `.claude/commands` gets no command action at
 * all — for any harness — so a case about how a command drops has to stage one
 * first, or it is asserting on an empty list.
 */
function planWithCommands(manifest: ReturnType<typeof parseHarnessManifest>) {
  return buildPlan({
    repoRoot: dir,
    manifest,
    claudeHooks,
    agentsMdExists: true,
    claudeCommandsExist: true,
  });
}

describe('buildPlan', () => {
  it('SK-01: projects a skill as a symlink for claude-code and native for codex', () => {
    // claude-code symlinks .agents/skills into .claude/skills; codex reads it directly.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'codex'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const skillActions = plan.actions.filter((a) => a.artifact === 'skill' && a.name === 'demo');
    expect(skillActions.find((a) => a.harness === 'claude-code')).toMatchObject({
      kind: 'symlink',
      source: '.agents/skills/demo',
      target: '.claude/skills/demo',
    });
    expect(skillActions.find((a) => a.harness === 'codex')).toMatchObject({
      kind: 'native',
      source: '.agents/skills/demo',
    });
  });

  it('HK-01, CM-04: generates a codex hooks action with attached content and drops codex commands', () => {
    // Codex hooks come from .claude/settings.json (generate); codex has no slash-command format.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'codex'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const gen = plan.actions.find(
      (a) => a.harness === 'codex' && a.artifact === 'hook' && a.kind === 'generate'
    );
    expect(gen?.target).toBe('.codex/hooks.json');
    expect(getActionContent(gen!)).toContain('Stop');

    const withCommands = planWithCommands(manifest);
    const commandDrop = withCommands.drops.find(
      (a) => a.harness === 'codex' && a.artifact === 'command'
    );
    expect(commandDrop?.kind).toBe('drop');
    expect(commandDrop?.reason).toMatch(/slash-command/);
  });

  it('HK-01: writes the Codex hooks file in the shape Codex documents, not a bare event map', () => {
    // Codex reads `{ description?, hooks: { <Event>: [...] } }` (learn.chatgpt.com/docs/hooks).
    // The engine used to serialize the bare event map, which Codex does not
    // document and most likely never reads (HK-01). The `description` doubles as
    // the human-readable marker on a machine-generated file.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'codex'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const gen = plan.actions.find(
      (a) => a.harness === 'codex' && a.artifact === 'hook' && a.kind === 'generate'
    );
    const parsed = JSON.parse(getActionContent(gen!)!) as {
      description: string;
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(parsed).sort()).toEqual(['description', 'hooks']);
    expect(parsed.description).toBe(GENERATED_HOOKS_DESCRIPTION);
    expect(Object.keys(parsed.hooks)).toEqual(['Stop']);
  });

  it('HK-04: surfaces a plan warning when a projected codex hook carries a Claude-only token', () => {
    // A Stop hook using ${CLAUDE_PLUGIN_ROOT} still projects, but lands in
    // plan.warnings attributed to codex so the CLI can tell the operator.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'codex'] });
    const claudeOnly: ClaudeHooksConfig = {
      Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/h.mjs"' }] }],
    };
    const plan = buildPlan({
      repoRoot: dir,
      manifest,
      claudeHooks: claudeOnly,
      agentsMdExists: true,
    });

    // The hook still projects (generate action present).
    const gen = plan.actions.find(
      (a) => a.harness === 'codex' && a.artifact === 'hook' && a.kind === 'generate'
    );
    expect(gen).toBeDefined();

    // And a warning is attributed to codex.
    const warning = plan.warnings.find((w) => w.harness === 'codex' && w.artifact === 'hook');
    expect(warning).toBeDefined();
    expect(warning?.name).toBe('Stop');
    expect(warning?.reason).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('HK-02: generates a cursor hooks action at .cursor/hooks.json with a { version, hooks } file', () => {
    // FND-6: hooks now project to Cursor as a standalone generated file.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'cursor'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const gen = plan.actions.find(
      (a) => a.harness === 'cursor' && a.artifact === 'hook' && a.kind === 'generate'
    );
    expect(gen?.target).toBe('.cursor/hooks.json');
    const content = getActionContent(gen!);
    expect(content).toContain('"version": 1');
    expect(content).toContain('stop'); // Stop -> cursor camelCase `stop`
  });

  it('HK-02: generates a copilot hooks action at .github/hooks/copilot-hooks.json', () => {
    // FND-6: hooks now project to Copilot as a standalone generated file.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'copilot'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const gen = plan.actions.find(
      (a) => a.harness === 'copilot' && a.artifact === 'hook' && a.kind === 'generate'
    );
    expect(gen?.target).toBe('.github/hooks/copilot-hooks.json');
    const content = getActionContent(gen!);
    expect(content).toContain('"version": 1');
    expect(content).toContain('agentStop'); // Stop -> copilot `agentStop`
  });

  it('HK-02: drops a cursor hook event with no Cursor home and surfaces a Cursor-named warning', () => {
    // permissionRequest has no Cursor map entry -> honest drop; a Claude-only
    // token on a mappable event warns naming Cursor (FND-11).
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'cursor'] });
    const hooks: ClaudeHooksConfig = {
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/h.mjs"' }] }],
    };
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks: hooks, agentsMdExists: true });

    const drop = plan.drops.find(
      (a) => a.harness === 'cursor' && a.artifact === 'hook' && a.name === 'PermissionRequest'
    );
    expect(drop?.reason).toMatch(/Cursor/);

    const warning = plan.warnings.find((w) => w.harness === 'cursor' && w.artifact === 'hook');
    expect(warning?.reason).toMatch(/Cursor/);
    expect(warning?.reason).not.toMatch(/Codex/);
  });

  it('HK-03: drops gemini hooks honestly (shared settings.json merge is a follow-up), never generating', () => {
    // Gemini hooks live inside the SHARED .gemini/settings.json; the engine must
    // NOT generate/clobber it, so it is an honest drop with a precise reason.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'gemini'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    // No generate action for gemini.
    expect(plan.actions.some((a) => a.harness === 'gemini' && a.artifact === 'hook')).toBe(false);

    const drop = plan.drops.find((a) => a.harness === 'gemini' && a.artifact === 'hook');
    expect(drop?.kind).toBe('drop');
    expect(drop?.reason).toMatch(/settings\.json/);
  });
});

describe('buildPlan — `native` only when the source is really there', () => {
  /** Every enabled harness, so a per-harness count assertion has a subject. */
  const ALL = parseHarnessManifest({ version: 1, harnesses: [...HARNESS_IDS] });

  it('IN-03: drops instructions on every enabled harness when there is no AGENTS.md', () => {
    // Reproduced 2026-09-07: the same plan carried `codex native AGENTS.md` and
    // `claude-code drop … no AGENTS.md to point at`.
    dir = fixtureRepo();
    const plan = buildPlan({ repoRoot: dir, manifest: ALL, claudeHooks, agentsMdExists: false });

    const instructionDrops = plan.drops.filter((a) => a.artifact === 'instruction');
    expect(instructionDrops).toHaveLength(HARNESS_IDS.length);
    expect(new Set(instructionDrops.map((a) => a.harness))).toEqual(new Set(HARNESS_IDS));
    expect(plan.actions.filter((a) => a.artifact === 'instruction')).toEqual([]);
  });

  it('IN-01: still projects instructions to every harness when AGENTS.md exists', () => {
    dir = fixtureRepo();
    const plan = buildPlan({ repoRoot: dir, manifest: ALL, claudeHooks, agentsMdExists: true });
    expect(plan.actions.filter((a) => a.artifact === 'instruction')).toHaveLength(
      HARNESS_IDS.length
    );
    expect(plan.drops.filter((a) => a.artifact === 'instruction')).toEqual([]);
  });

  it('HK-01: emits NO claude-code hook action when .claude/settings.json declares no hooks', () => {
    // There is no artifact, so there is nothing to call native and nothing to
    // drop either — a drop line implies something exists that could not travel.
    dir = fixtureRepo();
    const plan = buildPlan({ repoRoot: dir, manifest: ALL, agentsMdExists: true });

    const claudeHookActions = [...plan.actions, ...plan.drops].filter(
      (a) => a.artifact === 'hook' && a.harness === 'claude-code'
    );
    expect(claudeHookActions).toEqual([]);
  });

  it('HK-01: calls claude-code hooks native only once .claude/settings.json really declares some', () => {
    dir = fixtureRepo();
    const plan = buildPlan({ repoRoot: dir, manifest: ALL, claudeHooks, agentsMdExists: true });
    const native = plan.actions.find(
      (a) => a.artifact === 'hook' && a.harness === 'claude-code' && a.kind === 'native'
    );
    expect(native?.source).toBe('.claude/settings.json');
  });

  it('says NOTHING about hooks or commands, on any harness, when the repo has neither', () => {
    // The rule is universal, not a Claude Code carve-out. A repo with no
    // `.claude/commands` and no hooks used to be handed five command drops and
    // two hook drops — "no repo-local slash-command format", "OpenCode has no
    // declarative hook config" — about artifacts it does not have. Claude Code
    // was the only harness kept quiet, which made the silence look like a bug in
    // the other five rather than the correct answer for all six.
    dir = fixtureRepo();
    const plan = buildPlan({
      repoRoot: dir,
      manifest: ALL,
      agentsMdExists: true,
      claudeCommandsExist: false,
    });

    const lines = [...plan.actions, ...plan.drops].filter(
      (a) => a.artifact === 'command' || a.artifact === 'hook'
    );
    expect(lines).toEqual([]);
    // The plan is not empty — the skills and instructions are still in it — so
    // this is silence about two artifacts, not a plan that failed to build.
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  it('HK-03: drops hooks for OpenCode and Gemini once the repo really has some', () => {
    // The other half of the same rule: the drops are honest when there IS an
    // artifact, and both of these harnesses genuinely cannot take one.
    dir = fixtureRepo();
    const plan = buildPlan({ repoRoot: dir, manifest: ALL, claudeHooks, agentsMdExists: true });

    const hookDrops = plan.drops.filter((a) => a.artifact === 'hook');
    expect(new Set(hookDrops.map((a) => a.harness))).toEqual(new Set(['opencode', 'gemini']));
  });

  it('CM-04: emits NO claude-code command action when .claude/commands does not exist', () => {
    // `projector.ts` asserted `native` with `source: .claude/commands` whether or
    // not the directory was there (reproduced 2026-09-07).
    dir = fixtureRepo();
    const plan = buildPlan({
      repoRoot: dir,
      manifest: ALL,
      claudeHooks,
      agentsMdExists: true,
      claudeCommandsExist: false,
    });
    const claudeCommandActions = [...plan.actions, ...plan.drops].filter(
      (a) => a.artifact === 'command' && a.harness === 'claude-code'
    );
    expect(claudeCommandActions).toEqual([]);
  });

  it('CM-04: calls claude-code commands native once the directory holds at least one .md', () => {
    dir = fixtureRepo();
    const plan = buildPlan({
      repoRoot: dir,
      manifest: ALL,
      claudeHooks,
      agentsMdExists: true,
      claudeCommandsExist: true,
    });
    const native = plan.actions.find(
      (a) => a.artifact === 'command' && a.harness === 'claude-code' && a.kind === 'native'
    );
    expect(native?.source).toBe('.claude/commands');
  });
});

describe('buildPlan — authored skills reach every harness that reads .agents/skills', () => {
  it('SK-05: is native for cursor, gemini and copilot, which all read .agents/skills', () => {
    // All three read the canonical directory natively (vendor docs, 2026-09-07),
    // so the old "not auto-projected in v1; see DOR-143" drop told three sets of
    // users their skills did not travel when they did.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({
      version: 1,
      harnesses: ['cursor', 'gemini', 'copilot'],
    });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const skillActions = plan.actions.filter((a) => a.artifact === 'skill' && a.name === 'demo');
    expect(skillActions).toHaveLength(3);
    for (const action of skillActions) {
      expect({ harness: action.harness, kind: action.kind, source: action.source }).toEqual({
        harness: action.harness,
        kind: 'native',
        source: '.agents/skills/demo',
      });
      expect(action.reason).toContain('.agents/skills');
    }
    expect(plan.drops.filter((a) => a.artifact === 'skill')).toEqual([]);
  });
});

describe('buildPlan — authored command drops name each harness’s own format', () => {
  it('CM-04: gives cursor, gemini, codex and copilot honest, harness-specific reasons', () => {
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({
      version: 1,
      harnesses: ['codex', 'cursor', 'gemini', 'copilot'],
    });
    const plan = planWithCommands(manifest);

    const byHarness = new Map(
      plan.drops
        .filter((d) => d.artifact === 'command' && d.provenance === 'authored')
        .map((d) => [d.harness, d.reason ?? ''])
    );
    expect(byHarness.size).toBe(4);
    expect(byHarness.get('cursor')).toContain('.cursor/commands/*.md');
    expect(byHarness.get('gemini')).toContain('.gemini/commands/*.toml');
    expect(byHarness.get('copilot')).toContain('.github/prompts/*.prompt.md');
    // Codex really has none: custom prompts were deprecated in favour of skills.
    expect(byHarness.get('codex')).toMatch(/no repo-local slash-command format/);
    for (const [harness, reason] of byHarness) {
      if (harness === 'codex') continue;
      expect(reason).not.toMatch(/no repo-local slash-command format/);
    }
  });
});

/**
 * `plan.notEnabled` — the harnesses this manifest does not enable that
 * something says it should (contract TR-11).
 *
 * Two sources, and the rules between them are the whole of it: a footprint is
 * evidence on disk, a `dorkos-runtime` entry is evidence about this DorkOS, and
 * the same harness must never be reported twice.
 */
describe('buildPlan — notEnabled', () => {
  /** A plan over the fixture repo, with whatever detection and DorkOS answered. */
  function planWith(
    harnesses: HarnessId[],
    found: { detectedHarnesses?: DetectedHarness[]; dorkosHarness?: HarnessId }
  ): ProjectionPlan {
    return buildPlan({
      repoRoot: dir,
      manifest: parseHarnessManifest({ version: 1, harnesses }),
      claudeHooks,
      agentsMdExists: true,
      ...found,
    });
  }

  it('TR-11: reports the harness DorkOS runs when the manifest does not enable it', () => {
    // The shape DOR-1901 found: an OpenCode project set up before DorkOS knew to
    // add its own harness. Detection finds nothing of Claude Code's — there is
    // nothing to find — so this entry is the only thing that can say so.
    dir = fixtureRepo();

    expect(planWith(['codex', 'opencode'], { dorkosHarness: 'claude-code' }).notEnabled).toEqual([
      { harness: 'claude-code', why: 'dorkos-runtime' },
    ]);
  });

  it('TR-11: says nothing when the manifest already enables it', () => {
    dir = fixtureRepo();

    expect(planWith(['claude-code'], { dorkosHarness: 'claude-code' }).notEnabled).toEqual([]);
  });

  it('TR-11: reports a harness once, keeping the answer that names a path', () => {
    // A repo that has BOTH a `.cursor/` and a DorkOS running Cursor is one
    // problem, and the more useful of the two sentences is the one with a path
    // in it — "we found this file" beats "we run this tool".
    dir = fixtureRepo();

    expect(
      planWith(['claude-code'], {
        detectedHarnesses: [{ harness: 'cursor', why: 'footprint', signal: '.cursor/' }],
        dorkosHarness: 'cursor',
      }).notEnabled
    ).toEqual([{ harness: 'cursor', why: 'footprint', signal: '.cursor/' }]);
  });

  it('TR-11: reports both when they are different harnesses, footprints first', () => {
    dir = fixtureRepo();

    expect(
      planWith(['codex'], {
        detectedHarnesses: [{ harness: 'cursor', why: 'footprint', signal: '.cursor/' }],
        dorkosHarness: 'claude-code',
      }).notEnabled
    ).toEqual([
      { harness: 'cursor', why: 'footprint', signal: '.cursor/' },
      { harness: 'claude-code', why: 'dorkos-runtime' },
    ]);
  });

  it('TR-11: says nothing about DorkOS when the caller did not answer', () => {
    // `buildPlan` reads no config, so a caller that has not looked gets the
    // honest answer rather than a guess at what DorkOS runs.
    dir = fixtureRepo();

    expect(planWith(['codex'], {}).notEnabled).toEqual([]);
  });
});
