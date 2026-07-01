import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { getActionContent } from '../content-map.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import type { ClaudeHooksConfig } from '../../generate/hooks.js';

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

describe('buildPlan', () => {
  it('projects a skill as a symlink for claude-code and native for codex', () => {
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

  it('generates a codex hooks action with attached content and drops codex commands', () => {
    // Codex hooks come from .claude/settings.json (generate); codex has no slash-command format.
    dir = fixtureRepo();
    const manifest = parseHarnessManifest({ version: 1, harnesses: ['claude-code', 'codex'] });
    const plan = buildPlan({ repoRoot: dir, manifest, claudeHooks, agentsMdExists: true });

    const gen = plan.actions.find(
      (a) => a.harness === 'codex' && a.artifact === 'hook' && a.kind === 'generate'
    );
    expect(gen?.target).toBe('.codex/hooks.json');
    expect(getActionContent(gen!)).toContain('Stop');

    const commandDrop = plan.drops.find((a) => a.harness === 'codex' && a.artifact === 'command');
    expect(commandDrop?.kind).toBe('drop');
    expect(commandDrop?.reason).toMatch(/slash-command/);
  });

  it('surfaces a plan warning when a projected codex hook carries a Claude-only token', () => {
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

  it('generates a cursor hooks action at .cursor/hooks.json with a { version, hooks } file', () => {
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

  it('generates a copilot hooks action at .github/hooks/copilot-hooks.json', () => {
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

  it('drops a cursor hook event with no Cursor home and surfaces a Cursor-named warning', () => {
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

  it('drops gemini hooks honestly (shared settings.json merge is a follow-up), never generating', () => {
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
