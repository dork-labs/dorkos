/** The file-tool hook notes mini app writes by real path, with the turn's agent and hold (DOR-4528). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  editedByAuthor,
  resetPathTrustWriters,
} from '../../../../extensions/pin/path-trust-writers.js';
import { createExtensionWriteNote, extensionWriteMatcher } from '../extension-write-note.js';

describe('createExtensionWriteNote', () => {
  let root: string;
  let home: string;
  let copy: { id: string; realPath: string };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-write-note-')));
    home = path.join(root, 'ana');
    copy = { id: 'desk', realPath: path.join(home, '.dork', 'extensions', 'desk') };
    await fs.mkdir(copy.realPath, { recursive: true });
  });
  afterEach(async () => {
    resetPathTrustWriters();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('notes a relative write, a new file included, as the turn’s agent', () => {
    const note = createExtensionWriteNote({ cwd: home, agentHome: home, held: () => false });
    note('Write', { file_path: '.dork/extensions/desk/new/server.ts', content: '' });
    expect(editedByAuthor(copy, home)).toBe(true);
  });

  it('a write through a link to the folder is noted at its real path', async () => {
    const link = path.join(root, 'link');
    await fs.symlink(copy.realPath, link);
    const note = createExtensionWriteNote({ cwd: root, agentHome: home, held: () => false });
    note('Edit', { file_path: path.join(link, 'server.ts'), old_string: 'a', new_string: 'b' });
    expect(editedByAuthor(copy, home)).toBe(true);
  });

  it('reads the hold on each call', () => {
    let held = false;
    const note = createExtensionWriteNote({ cwd: home, agentHome: home, held: () => held });
    held = true;
    note('Edit', { file_path: path.join(copy.realPath, 'server.ts') });
    expect(editedByAuthor(copy, home)).toBe(false);
  });

  it('a hold it cannot read notes the write as no one’s', () => {
    const note = createExtensionWriteNote({
      cwd: home,
      agentHome: home,
      held: () => {
        throw new Error('unreadable');
      },
    });
    note('Edit', { file_path: path.join(copy.realPath, 'server.ts') });
    expect(editedByAuthor(copy, home)).toBe(false);
  });

  it('the launch matcher notes a write, and a ceilinged turn’s write as held', async () => {
    const input = (file: string) =>
      ({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: file, content: '' },
      }) as never;
    const signal = { signal: new AbortController().signal };
    const open = extensionWriteMatcher({}, { sessionId: 's1', cwd: home, agentHome: home });
    expect(open.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(await open.hooks[0]!(input('.dork/extensions/desk/a.ts'), 't1', signal)).toEqual({
      continue: true,
    });
    expect(editedByAuthor(copy, home)).toBe(true);

    const ceilinged = extensionWriteMatcher(
      { turnPermissionCeiling: { asks: 'always', reach: 'edit' } },
      { sessionId: 's2', cwd: home, agentHome: home }
    );
    await ceilinged.hooks[0]!(input('.dork/extensions/desk/b.ts'), 't2', signal);
    expect(editedByAuthor(copy, home)).toBe(false);
  });

  it('ignores tools that do not write files', () => {
    const note = createExtensionWriteNote({ cwd: home, agentHome: home, held: () => false });
    note('Read', { file_path: path.join(copy.realPath, 'server.ts') });
    expect(editedByAuthor(copy, home)).toBe(false);
  });
});
