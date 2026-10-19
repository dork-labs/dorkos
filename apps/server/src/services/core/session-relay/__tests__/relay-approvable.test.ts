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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingApprovalCard } from '../approval-challenges.js';
import { relayApprovableCard } from '../relay-approvable.js';

let root: string;
let cwd: string;
let dorkHome: string;

const file = (toolName: string, target: string, field = 'file_path'): PendingApprovalCard => ({
  toolName,
  input: JSON.stringify({ [field]: target, content: 'x' }),
});

const approvable = (card: PendingApprovalCard) => relayApprovableCard(card, { cwd, dorkHome });

describe('relayApprovableCard', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-approvable-')));
    cwd = path.join(root, 'project');
    dorkHome = path.join(root, 'dork-home');
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(dorkHome, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each<[string, PendingApprovalCard]>([
    ['Bash', { toolName: 'Bash', input: JSON.stringify({ command: 'ls' }) }],
    ['WebFetch', { toolName: 'WebFetch', input: JSON.stringify({ url: 'https://x.test' }) }],
    ['WebSearch', { toolName: 'WebSearch', input: JSON.stringify({ query: 'dorkos' }) }],
    ['Write', file('Write', 'src/a.ts')],
    ['Edit', file('Edit', 'src/a.ts')],
    ['MultiEdit', file('MultiEdit', 'src/a.ts')],
    ['NotebookEdit', file('NotebookEdit', 'src/a.ipynb', 'notebook_path')],
    ['Codex Shell', { toolName: 'Shell', input: JSON.stringify({ command: ['ls'], cwd: '/' }) }],
    ['Codex ApplyPatch', { toolName: 'ApplyPatch', input: JSON.stringify({ changes: [{}] }) }],
  ])('allows %s', (_, card) => {
    expect(approvable(card)).toBe(true);
  });

  it.each<[string, () => PendingApprovalCard]>([
    ['Codex Permissions', () => ({ toolName: 'Permissions', input: '{}' })],
    [
      'Codex ApplyPatch asking for a write root',
      () => ({ toolName: 'ApplyPatch', input: '{"changes":[{}]}', blockedPath: '/' }),
    ],
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

  it('refuses a relative path when the chat has no folder', () => {
    expect(relayApprovableCard(file('Write', 'src/a.ts'), { cwd: null, dorkHome })).toBe(false);
  });
});
