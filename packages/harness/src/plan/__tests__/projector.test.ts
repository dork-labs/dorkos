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
});
