/** The file-tool hooks note mini app writes by real path, with the turn's agent and hold (DOR-4528). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  contentOf,
  resetPathTrustWriters,
  tiedToAuthor,
} from '../../../../extensions/pin/path-trust-writers.js';
import { NOTE_WRITES_AFTER, expectedAfterOf, noteWritesBefore } from '../extension-write-note.js';

const signal = { signal: new AbortController().signal };

describe('extension write hooks', () => {
  let root: string;
  let home: string;
  let folder: string;
  let trusted: Record<string, string>;

  /** Run one tool call through the hooks a launch adds, writing what the tool would. */
  async function call(
    matcher: ReturnType<typeof noteWritesBefore>,
    id: string,
    tool: string,
    input: Record<string, unknown>,
    write: () => Promise<void>,
    fails = false
  ) {
    const base = { tool_name: tool, tool_input: input, tool_use_id: id };
    await matcher.hooks[0]!({ ...base, hook_event_name: 'PreToolUse' } as never, id, signal);
    if (!fails) await write();
    const event = fails ? 'PostToolUseFailure' : 'PostToolUse';
    await NOTE_WRITES_AFTER.hooks[0]!({ ...base, hook_event_name: event } as never, id, signal);
  }
  const check = async () => {
    const next: Record<string, string> = {};
    for (const name of await fs.readdir(folder))
      next[name] = await contentOf(path.join(folder, name));
    return tiedToAuthor({ id: 'desk', folder, authorHome: home, trusted, next });
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-write-note-')));
    home = path.join(root, 'ana');
    folder = path.join(home, '.dork', 'extensions', 'desk');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'server.ts'), 'const a = 1;\n');
    trusted = { 'server.ts': await contentOf(path.join(folder, 'server.ts')) };
  });
  afterEach(async () => {
    resetPathTrustWriters();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('notes a relative Write, a new file included, as the turn’s agent', async () => {
    const open = noteWritesBefore({}, { sessionId: 's1', cwd: home, agentHome: home });
    expect(open.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    await call(
      open,
      't1',
      'Write',
      { file_path: '.dork/extensions/desk/new.ts', content: 'n' },
      () => fs.writeFile(path.join(folder, 'new.ts'), 'n')
    );
    expect(await check()).toBe(true);
  });

  it('notes an Edit through a link to the folder at its real path', async () => {
    const link = path.join(root, 'link');
    await fs.symlink(folder, link);
    const open = noteWritesBefore({}, { sessionId: 's1', cwd: root, agentHome: home });
    const input = { file_path: path.join(link, 'server.ts'), old_string: '1', new_string: '2' };
    await call(open, 't1', 'Edit', input, () =>
      fs.writeFile(path.join(folder, 'server.ts'), 'const a = 2;\n')
    );
    expect(await check()).toBe(true);
  });

  it('a ceilinged turn’s write is held', async () => {
    const ceilinged = noteWritesBefore(
      { turnPermissionCeiling: { asks: 'always', reach: 'edit' } },
      { sessionId: 's2', cwd: home, agentHome: home }
    );
    const input = { file_path: path.join(folder, 'server.ts'), content: 'x' };
    await call(ceilinged, 't2', 'Write', input, () =>
      fs.writeFile(path.join(folder, 'server.ts'), 'x')
    );
    expect(await check()).toBe(false);
  });

  it('a write that failed is dropped', async () => {
    const open = noteWritesBefore({}, { sessionId: 's1', cwd: home, agentHome: home });
    const input = { file_path: path.join(folder, 'server.ts'), content: 'x' };
    await call(open, 't3', 'Write', input, async () => undefined, true);
    await fs.writeFile(path.join(folder, 'server.ts'), 'x');
    expect(await check()).toBe(false);
  });

  it('works out what each tool should leave, and nothing it cannot', () => {
    const before = Buffer.from('a b a');
    const after = (tool: string, input: Record<string, unknown>, from: Buffer | null = before) =>
      expectedAfterOf(tool, input)(from)?.toString('utf8') ?? null;
    expect(after('Write', { content: 'x' })).toBe('x');
    expect(after('Edit', { old_string: 'b', new_string: 'c' })).toBe('a c a');
    // Not found exactly once: the tool would fail, or leave something else.
    expect(after('Edit', { old_string: 'a', new_string: 'c' })).toBeNull();
    expect(after('Edit', { old_string: 'a', new_string: 'c', replace_all: true })).toBe('c b c');
    expect(after('Edit', { old_string: '', new_string: 'new' }, null)).toBe('new');
    expect(
      after('MultiEdit', {
        edits: [
          { old_string: 'b', new_string: 'x' },
          { old_string: 'x', new_string: 'y' },
        ],
      })
    ).toBe('a y a');
    expect(after('MultiEdit', { edits: [{ old_string: 'zzz', new_string: 'y' }] })).toBeNull();
    expect(after('NotebookEdit', { new_source: 'x' })).toBeNull();
  });
});
