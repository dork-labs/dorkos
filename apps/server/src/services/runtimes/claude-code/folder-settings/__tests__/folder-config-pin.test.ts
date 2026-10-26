/**
 * The digest a person's approval of an agent's folder settings pins: three
 * parts, each moving only when what it covers changes (DOR-3068).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedParts, readFolderConfigParts } from '../folder-config-pin.js';

let home: string;

function write(rel: string, body: unknown): void {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

/** Which parts moved across `change`. */
function partsMovedBy(change: () => void) {
  const before = readFolderConfigParts(home).digests;
  change();
  return changedParts(readFolderConfigParts(home).digests, before);
}

const HOOK = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] };
const SERVER = {
  name: 'notes',
  enabled: true,
  connection: { transport: 'stdio', command: 'notes-server', args: [], env: {} },
  addedAt: '2026-10-01T00:00:00.000Z',
  addedBy: 'operator',
};

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-config-pin-')));
  write('.claude/settings.json', { permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' });
  write('.mcp.json', { mcpServers: {} });
  write('.dork/agent.json', { id: '01AGENT', name: 'a', mcpServers: [SERVER], account: 'work' });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('readFolderConfigParts', () => {
  it('is stable across reads and across key order', () => {
    const first = readFolderConfigParts(home);
    write('.dork/agent.json', { account: 'work', mcpServers: [SERVER], name: 'a', id: '01AGENT' });
    expect(readFolderConfigParts(home)).toEqual(first);
    expect(first.unverifiable).toEqual([]);
  });

  it.each([
    ['a hook in settings.json', () => write('.claude/settings.json', { hooks: HOOK })],
    ['a hook in settings.local.json', () => write('.claude/settings.local.json', { hooks: HOOK })],
    ['a status line', () => write('.claude/settings.json', { statusLine: { command: 'x' } })],
    ['a plugin', () => write('.claude/settings.json', { enabledPlugins: { 'p@m': true } })],
    [
      'every project server on',
      () => write('.claude/settings.json', { enableAllProjectMcpServers: true }),
    ],
  ])('moves only the hooks part for %s', (_label, change) => {
    expect(partsMovedBy(change)).toEqual(['hooks']);
  });

  it('ignores settings that run no code', () => {
    expect(
      partsMovedBy(() =>
        write('.claude/settings.json', { permissions: { allow: ['Bash(cat:*)'] }, model: 'haiku' })
      )
    ).toEqual([]);
  });

  it('moves only the mcpJson part when .mcp.json changes, and when it goes away', () => {
    expect(
      partsMovedBy(() => write('.mcp.json', { mcpServers: { x: { command: 'evil' } } }))
    ).toEqual(['mcpJson']);
    expect(partsMovedBy(() => fs.rmSync(path.join(home, '.mcp.json')))).toEqual(['mcpJson']);
  });

  it('moves only the manifest part for a new server or a new account', () => {
    const other = { ...SERVER, name: 'other', connection: { ...SERVER.connection, command: 'x' } };
    expect(
      partsMovedBy(() =>
        write('.dork/agent.json', { id: '01AGENT', mcpServers: [SERVER, other], account: 'work' })
      )
    ).toEqual(['manifest']);
    expect(
      partsMovedBy(() =>
        write('.dork/agent.json', { id: '01AGENT', mcpServers: [SERVER, other], account: 'home' })
      )
    ).toEqual(['manifest']);
  });

  it('ignores the rest of the agent file, the audit fields and a learned sign-in kind', () => {
    expect(
      partsMovedBy(() =>
        write('.dork/agent.json', {
          id: '01AGENT',
          name: 'renamed',
          description: 'new words',
          mcpServers: [{ ...SERVER, addedAt: '2026-10-02T00:00:00.000Z', addedBy: 'someone' }],
          account: 'work',
        })
      )
    ).toEqual([]);
  });

  it('counts a malformed file as a change of its own', () => {
    expect(partsMovedBy(() => write('.claude/settings.json', '{ not json'))).toEqual(['hooks']);
    expect(partsMovedBy(() => write('.claude/settings.json', '{ still not json'))).toEqual([
      'hooks',
    ]);
  });

  it('follows a symlinked settings file to what Claude Code would read', () => {
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({}));
    fs.rmSync(path.join(home, '.claude', 'settings.json'));
    fs.symlinkSync(target, path.join(home, '.claude', 'settings.json'));
    expect(partsMovedBy(() => fs.writeFileSync(target, JSON.stringify({ hooks: HOOK })))).toEqual([
      'hooks',
    ]);
  });

  it('cannot vouch for a file that is too big or not a file', () => {
    write('.mcp.json', ' '.repeat(65 * 1024));
    fs.rmSync(path.join(home, '.claude', 'settings.json'));
    fs.mkdirSync(path.join(home, '.claude', 'settings.json'));
    expect(readFolderConfigParts(home).unverifiable).toEqual(['hooks', 'mcpJson']);
  });

  it('reads a home with none of the files as all absent, and vouches for it', () => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    expect(readFolderConfigParts(home).unverifiable).toEqual([]);
  });
});

describe('the scripts a hook runs', () => {
  /** A hook whose command is `command`. */
  const hookRunning = (command: string) => ({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
  });

  beforeEach(() => {
    write('.claude/hooks/guard.sh', '#!/bin/sh\nexit 0\n');
    write('.claude/settings.json', hookRunning('sh .claude/hooks/guard.sh'));
  });

  it('flips the pin when a script under .claude/hooks is edited', () => {
    expect(partsMovedBy(() => write('.claude/hooks/guard.sh', '#!/bin/sh\ncurl evil\n'))).toEqual([
      'hooks',
    ]);
  });

  it('flips the pin when a new file appears under .claude/hooks, at any depth', () => {
    expect(partsMovedBy(() => write('.claude/hooks/extra.sh', 'echo hi'))).toEqual(['hooks']);
    expect(partsMovedBy(() => write('.claude/hooks/lib/util.sh', 'echo hi'))).toEqual(['hooks']);
  });

  it('keeps the pin while the scripts are untouched, whatever else in the home changes', () => {
    expect(
      partsMovedBy(() => {
        write('notes.md', 'new notes');
        write('src/app.ts', 'export {};');
        write('.claude/hooks/guard.sh', '#!/bin/sh\nexit 0\n');
      })
    ).toEqual([]);
  });

  it('covers a script a hook names by a relative path outside .claude/hooks', () => {
    write('scripts/check.py', 'print(1)');
    write('.claude/settings.json', hookRunning('python3 scripts/check.py --strict'));
    expect(partsMovedBy(() => write('scripts/check.py', 'import os'))).toEqual(['hooks']);
  });

  it('covers a script named through $CLAUDE_PROJECT_DIR, and one that does not exist yet', () => {
    write('.claude/settings.json', hookRunning('"$CLAUDE_PROJECT_DIR"/tools/pre.sh'));
    expect(partsMovedBy(() => write('tools/pre.sh', 'echo created'))).toEqual(['hooks']);
    write(
      '.claude/settings.json',
      hookRunning('bash ${CLAUDE_PROJECT_DIR}/tools/pre.sh && echo ok')
    );
    expect(partsMovedBy(() => write('tools/pre.sh', 'echo edited'))).toEqual(['hooks']);
  });

  it('does not count a file a hook only writes its output to', () => {
    write('.claude/settings.json', hookRunning('date >> .claude/hook-log.txt'));
    expect(partsMovedBy(() => write('.claude/hook-log.txt', 'more lines'))).toEqual([]);
  });

  it('does not cover a script outside the home (the residual)', () => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.sh`);
    fs.writeFileSync(outside, 'echo a');
    write('.claude/settings.json', hookRunning(`sh ${outside} ../escape.sh`));
    try {
      expect(partsMovedBy(() => fs.writeFileSync(outside, 'echo b'))).toEqual([]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('cannot vouch for a symlink under .claude/hooks', () => {
    fs.symlinkSync(path.join(home, 'notes.md'), path.join(home, '.claude', 'hooks', 'link.sh'));
    expect(readFolderConfigParts(home).unverifiable).toEqual(['hooks']);
  });

  it('cannot vouch for a symlinked script a hook names', () => {
    fs.symlinkSync(path.join(home, 'notes.md'), path.join(home, 'run.sh'));
    write('.claude/settings.json', hookRunning('sh run.sh'));
    expect(readFolderConfigParts(home).unverifiable).toEqual(['hooks']);
  });

  it('cannot vouch for a script over 64 KB', () => {
    write('.claude/hooks/big.sh', '#'.repeat(65 * 1024));
    expect(readFolderConfigParts(home).unverifiable).toEqual(['hooks']);
  });

  it('cannot vouch for more than 200 files, or a tree deeper than four levels', () => {
    for (let i = 0; i < 201; i += 1) write(`.claude/hooks/many/f${i}.sh`, String(i));
    expect(readFolderConfigParts(home).unverifiable).toEqual(['hooks']);
    fs.rmSync(path.join(home, '.claude', 'hooks', 'many'), { recursive: true });
    expect(readFolderConfigParts(home).unverifiable).toEqual([]);
    write('.claude/hooks/a/b/c/d/deep.sh', 'echo');
    expect(readFolderConfigParts(home).unverifiable).toEqual(['hooks']);
  });
});
