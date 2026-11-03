/**
 * The file-read half of DOR-3300: `canUseTool` skips the card for a read only inside the turn's
 * folders, by its real path. What the real CLI does with this is
 * `shell-path-guard.binary.test.ts`.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanUseTool } from '../../messaging/interactive-handlers.js';
import type { StreamEvent } from '@dorkos/shared/types';

const noopLog = { debug: () => {}, info: () => {} };

let root: string;
let cwd: string;
let home: string;
let grant: string;
let outside: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'read-real-path-')));
  cwd = path.join(root, 'work');
  home = path.join(root, 'agent-home');
  grant = path.join(root, 'granted');
  outside = path.join(root, 'outside');
  for (const folder of [cwd, home, grant, outside]) mkdirSync(folder);
  writeFileSync(path.join(outside, 'plain.txt'), '');
  writeFileSync(path.join(cwd, 'notes.md'), '');
  symlinkSync(path.join(outside, 'plain.txt'), path.join(cwd, 'link-out.txt'));
  symlinkSync(outside, path.join(cwd, 'dir-out'));
  symlinkSync(path.join(cwd, 'notes.md'), path.join(outside, 'link-in.md'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Whether one call skipped the card. An unattended session ends an ask at once. */
async function skipsCard(
  toolName: string,
  input: Record<string, unknown>,
  permissionMode = 'default',
  folders: { cwd: string; roots: string[] } | undefined = { cwd, roots: [cwd, home, grant] }
): Promise<boolean> {
  const session = {
    permissionMode,
    unattended: true,
    pendingInteractions: new Map(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  };
  const canUseTool = createCanUseTool(
    session as never,
    noopLog,
    undefined,
    async () => ({}),
    folders
  );
  const result = await canUseTool(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: 'read-1',
  });
  return result.behavior === 'allow';
}

describe('a file read and the card (DOR-3300)', () => {
  it.each(['default', 'acceptEdits', 'plan', 'auto'])('skips it inside at %s', async (mode) => {
    expect(await skipsCard('Read', { file_path: path.join(cwd, 'notes.md') }, mode)).toBe(true);
  });

  it('skips it in the agent home and a granted folder', async () => {
    expect(await skipsCard('Read', { file_path: path.join(home, 'x.md') })).toBe(true);
    expect(await skipsCard('Read', { file_path: path.join(grant, 'x.md') })).toBe(true);
  });

  it('skips it for a relative path, and for a search with no path', async () => {
    expect(await skipsCard('Read', { file_path: 'notes.md' })).toBe(true);
    expect(await skipsCard('Grep', { pattern: 'x' })).toBe(true);
    expect(await skipsCard('Glob', { pattern: '**/*.ts' })).toBe(true);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto'])('asks outside at %s', async (mode) => {
    expect(await skipsCard('Read', { file_path: path.join(outside, 'plain.txt') }, mode)).toBe(
      false
    );
  });

  it.each([
    ['Read', () => ({ file_path: path.join(outside, 'plain.txt') })],
    ['NotebookRead', () => ({ notebook_path: path.join(outside, 'n.ipynb') })],
    ['Grep', () => ({ pattern: 'x', path: outside })],
    ['Glob', () => ({ pattern: '*', path: outside })],
    ['Glob', () => ({ pattern: `${outside}/*` })],
    ['LS', () => ({ path: outside })],
  ])('asks for %s outside', async (tool, input) => {
    expect(await skipsCard(tool, input())).toBe(false);
  });

  it('asks for `~` and `..`, which only look inside', async () => {
    expect(await skipsCard('Read', { file_path: '~/.ssh/id_ed25519' })).toBe(false);
    expect(await skipsCard('Read', { file_path: '../outside/plain.txt' })).toBe(false);
  });

  it('lets the real path decide a link, both ways', async () => {
    expect(await skipsCard('Read', { file_path: path.join(cwd, 'link-out.txt') })).toBe(false);
    expect(await skipsCard('Read', { file_path: path.join(cwd, 'dir-out', 'plain.txt') })).toBe(
      false
    );
    expect(await skipsCard('Read', { file_path: path.join(outside, 'link-in.md') })).toBe(true);
  });

  it('asks when no folder is known', async () => {
    const session = {
      permissionMode: 'default',
      unattended: true,
      pendingInteractions: new Map(),
      eventQueue: [] as StreamEvent[],
    };
    const result = await createCanUseTool(session as never, noopLog)(
      'Read',
      { file_path: '/tmp/x' },
      { signal: new AbortController().signal, toolUseID: 'none' }
    );
    expect(result.behavior).toBe('deny');
  });

  it('leaves Full alone: it reads anywhere', async () => {
    expect(
      await skipsCard('Read', { file_path: path.join(outside, 'plain.txt') }, 'bypassPermissions')
    ).toBe(true);
  });

  it('leaves the web tools alone: they name no file', async () => {
    expect(await skipsCard('WebFetch', { url: 'https://example.com' })).toBe(true);
    expect(await skipsCard('WebSearch', { query: 'x' })).toBe(true);
  });
});
