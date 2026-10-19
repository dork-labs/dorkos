/**
 * @vitest-environment node
 *
 * Which pending tool approvals the web may answer: a short, fail-closed list
 * of one-shot tools, with file tools kept out of settings folders and the
 * DorkOS data folder, and Codex placeholder inputs refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { PendingApprovalCard } from '../approval-challenges.js';
import { relayApprovableCard } from '../relay-approvable.js';
import { relayProtectedRoots } from '../relay-protected-roots.js';

let root: string;
let cwd: string;
let dorkHome: string;

const file = (toolName: string, target: string, field = 'file_path'): PendingApprovalCard => ({
  toolName,
  input: JSON.stringify({ [field]: target, content: 'x' }),
});

const approvable = (card: PendingApprovalCard, caseInsensitive?: boolean) =>
  relayApprovableCard(card, {
    cwd,
    protectedRoots: [dorkHome],
    ...(caseInsensitive !== undefined ? { caseInsensitive } : {}),
  });

const patch = (...paths: unknown[]): PendingApprovalCard => ({
  toolName: 'ApplyPatch',
  input: JSON.stringify({ changes: paths.map((p) => ({ path: p, kind: 'add' })) }),
});

describe('relayApprovableCard', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-approvable-')));
    cwd = path.join(root, 'project');
    dorkHome = path.join(root, 'dork-home');
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(dorkHome, { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each<[string, PendingApprovalCard]>([
    ['Bash', { toolName: 'Bash', input: JSON.stringify({ command: 'ls' }) }],
    ['WebFetch', { toolName: 'WebFetch', input: JSON.stringify({ url: 'https://x.test' }) }],
    ['WebSearch', { toolName: 'WebSearch', input: JSON.stringify({ query: 'dorkos' }) }],
    ['Write', file('Write', 'src/a.ts')],
    ['Edit', file('Edit', 'src/a.ts')],
    ['MultiEdit', file('MultiEdit', 'src/a.ts')],
    ['NotebookEdit', file('NotebookEdit', 'src/a.ipynb', 'notebook_path')],
    ['Codex Shell', { toolName: 'Shell', input: JSON.stringify({ command: ['ls'], cwd: '/' }) }],
  ])('allows %s', (_, card) => {
    expect(approvable(card)).toBe(true);
  });

  it('allows a Codex patch whose every change is to an allowed file', () => {
    expect(approvable(patch(path.join(cwd, 'src/a.ts'), 'src/b.ts'))).toBe(true);
  });

  it.each<[string, () => PendingApprovalCard]>([
    ['Codex Permissions', () => ({ toolName: 'Permissions', input: '{}' })],
    [
      'Codex ApplyPatch asking for a write root',
      () => ({ ...patch(path.join(cwd, 'src/a.ts')), blockedPath: '/' }),
    ],
    [
      'Codex ApplyPatch into a .codex folder',
      () => ({
        toolName: 'ApplyPatch',
        input: '{"changes":[{"path":"/proj/.codex/config.toml","kind":"add"}]}',
      }),
    ],
    ['Codex ApplyPatch with one bad change of two', () => patch('src/a.ts', '.mcp.json')],
    ['Codex ApplyPatch with no changes field', () => ({ toolName: 'ApplyPatch', input: '{}' })],
    [
      'Codex ApplyPatch whose changes is not a list',
      () => ({ toolName: 'ApplyPatch', input: '{"changes":{"path":"src/a.ts"}}' }),
    ],
    ['Codex ApplyPatch with an empty change list', () => patch()],
    ['Codex ApplyPatch with a change that has no path', () => patch(undefined)],
    ['Codex ApplyPatch with a path that is not text', () => patch(42)],
    ['OpenCode external_directory', () => ({ toolName: 'external_directory', input: '{}' })],
    ['a DorkOS MCP tool', () => ({ toolName: 'mcp__dorkos__change_permission', input: '{}' })],
    ['another MCP server', () => ({ toolName: 'mcp__dorkos-connections__x', input: '{}' })],
    ['an unknown name', () => ({ toolName: 'dorkos_x', input: '{}' })],
    ['Task', () => ({ toolName: 'Task', input: '{}' })],
    ['Agent', () => ({ toolName: 'Agent', input: '{}' })],
    ['ExitPlanMode', () => ({ toolName: 'ExitPlanMode', input: '{}' })],
    ['Codex Shell placeholder', () => ({ toolName: 'Shell', input: '{}' })],
    [
      'Codex ApplyPatch placeholder',
      () => ({ toolName: 'ApplyPatch', input: JSON.stringify({ changes: [] }) }),
    ],
    ['Write to .claude/settings.json', () => file('Write', '.claude/settings.json')],
    ['Edit in a nested .dork folder', () => file('Edit', 'src/.dork/agent.json')],
    ['Write to a .codex folder by absolute path', () => file('Write', '/tmp/x/.codex/config.toml')],
    ['MultiEdit in .opencode', () => file('MultiEdit', '.opencode/opencode.json')],
    ['Write to the DorkOS config', () => file('Write', path.join(dorkHome, 'config.json'))],
    ['Write that climbs into the data folder', () => file('Write', '../dork-home/x.json')],
    ['Write with a .. part', () => file('Write', '/proj/docs/../settings.json')],
    ['Write with a Windows .. part', () => file('Write', 'docs\\..\\settings.json')],
    ['Write to a project opencode.json', () => file('Write', 'opencode.json')],
    ['Write to a project opencode.jsonc', () => file('Write', 'opencode.jsonc')],
    ['Write to a project .mcp.json', () => file('Write', '.mcp.json')],
    ['Write to a skill in .agents', () => file('Write', '.agents/skills/x/SKILL.md')],
    ['Write to a .claude2 account folder', () => file('Write', '/Users/x/.claude2/settings.json')],
    ['Write with no path', () => ({ toolName: 'Write', input: '{}' })],
    ['Write with input that is not JSON', () => ({ toolName: 'Write', input: 'nope' })],
  ])('refuses %s', (_, card) => {
    expect(approvable(card())).toBe(false);
  });

  it('follows a symlink into a settings folder', () => {
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.symlinkSync(path.join(cwd, '.claude'), path.join(cwd, 'innocent'));
    expect(approvable(file('Write', 'innocent/settings.json'))).toBe(false);
  });

  it('follows a symlink into the data folder', () => {
    fs.symlinkSync(dorkHome, path.join(cwd, 'home-link'));
    expect(approvable(file('Write', 'home-link/config.json'))).toBe(false);
  });

  it.each([
    ['.Claude', '/Users/x/.Claude/settings.json'],
    ['.DORK', '/Users/x/.DORK/agent.json'],
  ])('refuses %s on a file system that ignores case', (_, target) => {
    expect(approvable(file('Write', target), true)).toBe(false);
  });

  it('refuses the data folder spelled in another case where case is ignored', () => {
    const shouted = path.join(path.dirname(dorkHome), 'DORK-HOME', 'config.json');
    expect(approvable(file('Write', shouted), true)).toBe(false);
  });

  it('refuses a Claude Code account folder named by CLAUDE_CONFIG_DIR, whatever its name', () => {
    const account = path.join(root, 'claude-work');
    vi.stubEnv('CLAUDE_CONFIG_DIR', account);
    const roots = relayProtectedRoots();
    expect(roots).toContain(account);
    const card = file('Write', path.join(account, 'settings.json'));
    expect(relayApprovableCard(card, { cwd, protectedRoots: roots })).toBe(false);
    expect(relayApprovableCard(card, { cwd, protectedRoots: [] })).toBe(true);
  });

  it('refuses ~/.claude2 and ~/.config/opencode through the live roots', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(os.homedir(), '.claude2'));
    const roots = relayProtectedRoots();
    const context = { cwd, protectedRoots: roots };
    expect(roots).toContain(path.join(os.homedir(), '.config', 'opencode'));
    expect(
      relayApprovableCard(
        file('Write', path.join(os.homedir(), '.claude2', 'settings.json')),
        context
      )
    ).toBe(false);
    expect(
      relayApprovableCard(
        file('Write', path.join(os.homedir(), '.config', 'opencode', 'opencode.json')),
        context
      )
    ).toBe(false);
    expect(
      relayApprovableCard(
        file('Write', path.join(os.homedir(), '.config', 'opencode', 'agent', 'x.md')),
        context
      )
    ).toBe(false);
  });

  it('refuses a relative path when the chat has no folder', () => {
    expect(relayApprovableCard(file('Write', 'src/a.ts'), { cwd: null, protectedRoots: [] })).toBe(
      false
    );
  });
});
