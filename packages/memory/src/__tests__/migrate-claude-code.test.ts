/**
 * The Claude Code memory migration, on real temporary folders: what the dry run
 * plans, what the real run writes, and that originals are never touched.
 *
 * @vitest-environment node
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MOVED_MARKER_FILE,
  applyClaudeMemoryMigration,
  noteNameFrom,
  planClaudeMemoryMigration,
  renderMigrationReport,
} from '../migrate-claude-code.js';
import { listNotes, readNote } from '../notes.js';
import { readMemorySnapshot } from '../store.js';

const roots: string[] = [];
const slugOf = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

/** A home with two Claude accounts and two agents, one of which has notes in both. */
async function arrange() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-migrate-'));
  roots.push(root);
  const agentPath = path.join(root, 'agents', 'designer');
  const otherPath = path.join(root, 'agents', 'quiet');
  await mkdir(agentPath, { recursive: true });
  await mkdir(otherPath, { recursive: true });
  const folder = (account: string, cwd: string) =>
    path.join(root, account, 'projects', slugOf(cwd), 'memory');

  const a1 = folder('.claude', agentPath);
  const a3 = folder('.claude3', agentPath);
  const stray = folder('.claude', path.join(root, 'scratch'));
  for (const dir of [a1, a3, stray]) await mkdir(dir, { recursive: true });

  await writeFile(path.join(a1, 'MEMORY.md'), '# Memory index\n- [Tokens](tokens.md)\n');
  await writeFile(
    path.join(a1, 'tokens.md'),
    '---\nname: tokens\ndescription: Design tokens\nmetadata:\n  type: project\n---\n\nUse the 4px grid.\n'
  );
  await writeFile(path.join(a1, 'Same_Name.md'), 'identical in both accounts\n');
  await writeFile(path.join(a3, 'Same_Name.md'), 'identical in both accounts\n');
  await writeFile(path.join(a3, 'tokens.md'), 'a different tokens note\n');
  await writeFile(path.join(stray, 'loose.md'), 'nobody owns this\n');
  // A stray file beside the project folders, as macOS leaves one.
  await writeFile(path.join(root, '.claude', 'projects', '.DS_Store'), 'x');

  return {
    root,
    agentPath,
    a1,
    a3,
    stray,
    input: {
      accountDirs: [path.join(root, '.claude3'), path.join(root, '.claude')],
      agents: [
        { name: 'designer', path: agentPath },
        { name: 'quiet', path: otherPath },
      ],
      slugOf,
      date: '2026-10-17',
    },
  };
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('planClaudeMemoryMigration', () => {
  it('maps folders by slug, dedupes identical files, suffixes clashes by account', async () => {
    const { input, stray } = await arrange();
    const plan = await planClaudeMemoryMigration(input);
    expect(plan.agents).toHaveLength(1);
    const notes = plan.agents[0]!.notes.map((n) => [n.account, n.target, n.action]);
    expect(notes).toEqual([
      ['claude', 'claude-code-index-claude', 'copy'],
      ['claude', 'same_name', 'copy'],
      ['claude', 'tokens', 'copy'],
      ['claude3', 'same_name', 'same-as-other-account'],
      ['claude3', 'tokens--claude3', 'copy'],
    ]);
    expect(plan.unmatched).toEqual([
      { account: 'claude', folder: stray, files: 1, reason: 'no-agent' },
    ]);
  });

  it('writes nothing', async () => {
    const { input, agentPath } = await arrange();
    await planClaudeMemoryMigration(input);
    await expect(stat(path.join(agentPath, '.dork'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('puts the clashes at the top of the report', async () => {
    const { input } = await arrange();
    const report = renderMigrationReport(await planClaudeMemoryMigration(input));
    expect(report).toMatch(/^# .*Dry run/);
    expect(report.indexOf('## Name clashes')).toBeLessThan(report.indexOf('## Every note'));
    expect(report).toContain('`tokens--claude3`');
  });
});

describe('applyClaudeMemoryMigration', () => {
  it('copies with provenance, leaves markers, and never edits originals or MEMORY.md', async () => {
    const { input, agentPath, a1, a3 } = await arrange();
    const before = await readFile(path.join(a1, 'tokens.md'), 'utf8');
    const results = await applyClaudeMemoryMigration(await planClaudeMemoryMigration(input));
    expect(results[0]).toMatchObject({ copied: 4, markers: 2, failed: [] });

    const tokens = await readNote({ agentId: 'd', agentPath }, 'tokens');
    expect(tokens.content).toContain('description: Design tokens');
    expect(tokens.content).toContain('  type: project');
    expect(tokens.content).toContain('migratedFrom: "claude:tokens.md"');
    expect(tokens.content).not.toContain(a1);
    expect(tokens.content).toContain('(migrated from Claude Code memory, 2026-10-17)');
    const list = await listNotes({ agentId: 'd', agentPath }, {}, Date.parse('2026-10-18'));
    expect(list.total).toBe(4);
    expect(list.recentlyMigrated).toBe(4);

    expect((await readMemorySnapshot({ agentId: 'd', agentPath })).status).toBe('absent');

    expect(await readFile(path.join(a1, 'tokens.md'), 'utf8')).toBe(before);
    expect(await readdir(a3)).toContain(MOVED_MARKER_FILE);
  });

  it('leaves moved folders alone on a second run, so tidied notes stay gone', async () => {
    const { input, agentPath } = await arrange();
    await applyClaudeMemoryMigration(await planClaudeMemoryMigration(input));
    await rm(path.join(agentPath, '.dork', 'memory', 'tokens.md'));
    const second = await planClaudeMemoryMigration({ ...input, date: '2026-10-20' });
    expect(second.agents).toEqual([]);
    expect(second.unmatched.filter((u) => u.reason === 'already-moved')).toHaveLength(2);
  });

  it('with force, reads moved folders again but copies nothing twice', async () => {
    const { input } = await arrange();
    await applyClaudeMemoryMigration(await planClaudeMemoryMigration(input));
    const forced = await planClaudeMemoryMigration({ ...input, force: true });
    expect(forced.agents[0]!.notes.filter((n) => n.action === 'copy')).toEqual([]);
  });

  it('gives a long clashing name a suffix that survives the length limit, and never hangs', async () => {
    const { input, a1, a3 } = await arrange();
    const long = 'x'.repeat(90);
    await writeFile(path.join(a1, `${long}.md`), 'one\n');
    await writeFile(path.join(a3, `${long}.md`), 'two\n');
    const plan = await planClaudeMemoryMigration(input);
    const targets = plan.agents[0]!.notes.filter((n) => n.source.endsWith(`${long}.md`));
    expect(targets.map((n) => n.target)).toEqual(['x'.repeat(80), `${'x'.repeat(71)}--claude3`]);
  });

  it('leaves a named account alone unless it is included by name', async () => {
    const { input, root, agentPath } = await arrange();
    const work = path.join(root, '.claude-work', 'projects', slugOf(agentPath), 'memory');
    await mkdir(work, { recursive: true });
    await writeFile(path.join(work, 'client.md'), 'work notes\n');
    const accounts = [...input.accountDirs, path.join(root, '.claude-work')];
    const plan = await planClaudeMemoryMigration({ ...input, accountDirs: accounts });
    expect(plan.unmatched).toContainEqual({
      account: 'claude-work',
      folder: work,
      files: 1,
      reason: 'named-account',
    });
    expect(plan.agents[0]!.notes.some((n) => n.account === 'claude-work')).toBe(false);
    const included = await planClaudeMemoryMigration({
      ...input,
      accountDirs: accounts,
      includeAccounts: ['claude-work'],
    });
    expect(included.agents[0]!.notes.some((n) => n.target === 'client')).toBe(true);
  });

  it('reports two agents with one folder instead of guessing', async () => {
    const { input, agentPath } = await arrange();
    const plan = await planClaudeMemoryMigration({
      ...input,
      agents: [...input.agents, { name: 'twin', path: `${agentPath}/` }],
      slugOf: (p) => slugOf(p.replace(/\/$/, '')),
    });
    expect(plan.agents).toEqual([]);
    expect(plan.unmatched.some((u) => u.reason === 'two-agents')).toBe(true);
  });

  it('keeps a note the agent already has under the same name', async () => {
    const { input, agentPath } = await arrange();
    const dir = path.join(agentPath, '.dork', 'memory');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'tokens.md'), 'my own tokens note\n');
    const plan = await planClaudeMemoryMigration(input);
    const tokens = plan.agents[0]!.notes.find((n) =>
      n.source.endsWith('/.claude/projects/' + slugOf(agentPath) + '/memory/tokens.md')
    );
    expect(tokens).toMatchObject({ target: 'tokens--claude', renamedBecause: 'collision' });
    await applyClaudeMemoryMigration(plan);
    expect(await readFile(path.join(dir, 'tokens.md'), 'utf8')).toBe('my own tokens note\n');
  });
});

describe('noteNameFrom', () => {
  it('turns any file name into one the jail accepts', () => {
    expect(noteNameFrom('Project_Spec255 Stream.v2')).toBe('project_spec255-stream-v2');
    expect(noteNameFrom('--x')).toBe('x');
    expect(noteNameFrom('###')).toBe('note');
  });
});
