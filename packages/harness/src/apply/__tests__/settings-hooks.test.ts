import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';

let repo = '';
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = '';
});

/**
 * A claude-code repo with one project-installed plugin whose only hook command
 * does NOT reference its install path (the reviewer's `npx prettier` shape):
 * ownership must come from an explicit sentinel, never from path inference.
 */
function buildRepoWithPathlessHookPlugin(hookCommand = 'npx prettier --check .'): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-sentinel-'));
  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code'] }, null, 2)
  );
  const plugin = join(repoRoot, '.dork', 'plugins', 'tidy');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'tidy',
      version: '1.0.0',
      type: 'plugin',
      description: 'Tidy test plugin',
      layers: ['hooks'],
    })
  );
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: hookCommand }] }] })
  );
  return repoRoot;
}

/** All Stop hook command strings currently in the repo's settings.local.json. */
function stopCommands(repoRoot: string): string[] {
  const raw = readFileSync(join(repoRoot, '.claude', 'settings.local.json'), 'utf8');
  const settings = JSON.parse(raw) as {
    hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return (settings.hooks?.Stop ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

describe('managed settings hooks: explicit sentinel ownership (review blocker 1)', () => {
  it('keeps exactly one copy of a pathless plugin hook across three syncs (idempotent re-sync)', () => {
    repo = buildRepoWithPathlessHookPlugin();

    for (let i = 0; i < 3; i++) {
      const plan = project(repo);
      const result = applyPlan(repo, plan, { sweepOrphans: true });
      expect(result.conflicts).toEqual([]);
    }

    const copies = stopCommands(repo).filter((c) => c.includes('npx prettier'));
    expect(copies).toHaveLength(1);
  });

  it('converges: --check reports clean immediately after apply', () => {
    repo = buildRepoWithPathlessHookPlugin();
    const plan = project(repo);
    applyPlan(repo, plan, { sweepOrphans: true });
    expect(checkPlan(repo, plan).clean).toBe(true);
  });

  it('sweeps a pathless managed hook on uninstall', () => {
    repo = buildRepoWithPathlessHookPlugin();
    applyPlan(repo, project(repo), { sweepOrphans: true });
    expect(stopCommands(repo)).toContain('npx prettier --check .');

    rmSync(join(repo, '.dork', 'plugins', 'tidy'), { recursive: true, force: true });
    const result = applyPlan(repo, project(repo), { sweepOrphans: true });

    expect(result.swept).toContain('.claude/settings.local.json');
    const settings = JSON.parse(
      readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')
    ) as { hooks?: unknown };
    expect(settings.hooks).toBeUndefined();
  });

  it('never sweeps a USER hook that happens to reference .dork/plugins (no false positives)', () => {
    repo = buildRepoWithPathlessHookPlugin();
    // A user-authored hook whose command legitimately mentions the install root.
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cat .dork/plugins/notes.txt' }] }],
        },
      })
    );

    applyPlan(repo, project(repo), { sweepOrphans: true });
    // Uninstall: only the managed hook goes; the user's path-mentioning hook stays.
    rmSync(join(repo, '.dork', 'plugins', 'tidy'), { recursive: true, force: true });
    applyPlan(repo, project(repo), { sweepOrphans: true });

    const commands = stopCommands(repo);
    expect(commands).toContain('cat .dork/plugins/notes.txt');
    expect(commands).not.toContain('npx prettier --check .');
  });

  it('tags managed groups with the owning plugin so a multi-plugin uninstall is per-plugin', () => {
    repo = buildRepoWithPathlessHookPlugin();
    // Second plugin with its own pathless hook.
    const other = join(repo, '.dork', 'plugins', 'other');
    mkdirSync(join(other, '.dork'), { recursive: true });
    writeFileSync(
      join(other, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'other',
        version: '1.0.0',
        type: 'plugin',
        description: 'Other test plugin',
        layers: ['hooks'],
      })
    );
    mkdirSync(join(other, 'hooks'), { recursive: true });
    writeFileSync(
      join(other, 'hooks', 'hooks.json'),
      JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo other-done' }] }] })
    );

    applyPlan(repo, project(repo), { sweepOrphans: true });
    expect(stopCommands(repo)).toEqual(
      expect.arrayContaining(['npx prettier --check .', 'echo other-done'])
    );

    // Uninstall only `tidy`: its hook goes, `other`'s hook stays.
    rmSync(join(repo, '.dork', 'plugins', 'tidy'), { recursive: true, force: true });
    applyPlan(repo, project(repo), { sweepOrphans: true });
    const commands = stopCommands(repo);
    expect(commands).toContain('echo other-done');
    expect(commands).not.toContain('npx prettier --check .');
  });
});

describe('managed settings hooks: corrupt target aborts the merge (review blocker 2)', () => {
  it('reports a conflict and leaves a corrupt settings.local.json byte-identical', () => {
    repo = buildRepoWithPathlessHookPlugin();
    const settingsPath = join(repo, '.claude', 'settings.local.json');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    // A truncated, mid-write file: parseable-looking but invalid JSON.
    const corrupt = '{"permissions": {"allow": ["Bash"]';
    writeFileSync(settingsPath, corrupt);

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });

    // The merge surfaced as a conflict, was NOT applied, and never wrote.
    expect(result.conflicts.some((a) => a.kind === 'merge')).toBe(true);
    expect(result.applied.some((a) => a.kind === 'merge')).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(corrupt);
  });

  it('sweep is also a no-op on a corrupt file (never rewrites what it cannot parse)', () => {
    repo = buildRepoWithPathlessHookPlugin();
    const settingsPath = join(repo, '.claude', 'settings.local.json');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const corrupt = '{"hooks": {"Stop": [';
    writeFileSync(settingsPath, corrupt);

    rmSync(join(repo, '.dork', 'plugins', 'tidy'), { recursive: true, force: true });
    const result = applyPlan(repo, project(repo), { sweepOrphans: true });

    expect(result.swept).not.toContain('.claude/settings.local.json');
    expect(readFileSync(settingsPath, 'utf8')).toBe(corrupt);
  });
});

describe('command wrappers: authored directory collision (review nit 4)', () => {
  it('conflicts instead of co-opting an authored .claude/commands/<pkg>/ dir', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-cmdconflict-'));
    mkdirSync(join(repo, '.agents'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'] }, null, 2)
    );
    const plugin = join(repo, '.dork', 'plugins', 'acme');
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'acme',
        version: '1.0.0',
        type: 'plugin',
        description: 'Acme test plugin',
        layers: ['commands'],
      })
    );
    mkdirSync(join(plugin, 'commands'), { recursive: true });
    writeFileSync(join(plugin, 'commands', 'deploy.md'), '---\ndescription: d\n---\nbody\n');

    // The user already has an AUTHORED command namespace with the same name.
    const authoredDir = join(repo, '.claude', 'commands', 'acme');
    mkdirSync(authoredDir, { recursive: true });
    const authored = '---\ndescription: mine\n---\nhand-authored, no marker\n';
    writeFileSync(join(authoredDir, 'ship.md'), authored);

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });

    // Every wrapper generate for that plugin surfaces as a conflict...
    const wrapperConflicts = result.conflicts.filter((a) =>
      a.target?.startsWith('.claude/commands/acme/')
    );
    expect(wrapperConflicts.length).toBeGreaterThan(0);
    // ...nothing engine-owned was written into the authored dir...
    expect(existsSync(join(authoredDir, 'deploy.md'))).toBe(false);
    expect(existsSync(join(authoredDir, '.gitignore'))).toBe(false);
    // ...and the authored file is untouched.
    expect(readFileSync(join(authoredDir, 'ship.md'), 'utf8')).toBe(authored);
  });
});
