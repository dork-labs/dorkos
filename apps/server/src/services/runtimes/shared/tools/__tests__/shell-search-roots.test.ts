/**
 * Where a search starts and what it finds below (DOR-5261): room attachments copied into the tree
 * it searches, BSD `find` flags, `grep -d recurse`, flags that take a value, and wildcard roots.
 * Each test stands in a made-up home, outside the temp folder.
 *
 * @vitest-environment node
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolReadsOutsideText } from '../outside-text-tools.js';
import { commandReadsOutsideText } from '../shell-outside-text.js';
import { madeUpHome } from './made-up-home.js';

const homes: Array<() => void> = [];
/** Stand in a made-up home holding these folders, with the data folder kept elsewhere. */
const standIn = (folders: readonly string[], dorkHome = '/made-up/dork-home'): string => {
  const { home, remove } = madeUpHome(folders);
  homes.push(remove);
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dorkHome.replace('HOME', home));
  return home;
};
const marksIn = (cwd: string, command: string, agentHome = cwd) =>
  commandReadsOutsideText(command, { cwd, agentHome });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const remove of homes.splice(0)) remove();
});

describe('room attachments copied into the tree a search starts at', () => {
  const ATTACHMENTS = 'agents/wren/.dork/.temp/room-attachments/e1';
  const withAttachment = (): string => {
    const home = standIn([ATTACHMENTS]);
    writeFileSync(path.join(home, ATTACHMENTS, 'a1.txt'), 'made-up words');
    return path.join(home, 'agents', 'wren');
  };

  it.each(['grep -r secret .', 'grep -rn secret', 'find . -name "*.txt"', 'rg --hidden secret'])(
    '%s reaches them',
    (command) => {
      expect(marksIn(withAttachment(), command)).toBe(true);
    }
  );

  it('a search above the agent folder reaches them', () => {
    const agent = withAttachment();
    expect(marksIn(agent, 'grep -r secret ~')).toBe(true);
    expect(marksIn(agent, 'grep -r secret ../..')).toBe(true);
  });

  it('a search of an agent’s .dork from another folder reaches them', () => {
    const agent = withAttachment();
    const home = path.dirname(path.dirname(agent));
    expect(marksIn(home, 'grep -r secret agents/wren/.dork')).toBe(true);
    expect(marksIn(home, 'find agents/wren/.dork/.temp -type f')).toBe(true);
  });

  it('a search of the folders that hold them reaches them', () => {
    const agent = withAttachment();
    expect(marksIn(agent, 'grep -r secret .dork')).toBe(true);
    expect(marksIn(agent, 'find .dork/.temp -type f')).toBe(true);
    expect(marksIn(agent, 'rg secret .dork/.temp')).toBe(true);
  });

  it('rg and fd leave the hidden folder out', () => {
    const agent = withAttachment();
    expect(marksIn(agent, 'rg secret .')).toBe(false);
    expect(marksIn(agent, 'fd secret')).toBe(false);
  });

  it('the Grep tool rooted at the agent folder reaches them', () => {
    const agent = withAttachment();
    const place = { cwd: agent, agentHome: agent };
    expect(toolReadsOutsideText('claude-code', 'Grep', { pattern: 'secret' }, place)).toBe(true);
    expect(toolReadsOutsideText('opencode', 'grep', { pattern: 'secret' }, place)).toBe(true);
  });

  it('Doe’s search, which leaves hidden folders out, reaches them only when pointed there', () => {
    const agent = withAttachment();
    const place = { cwd: agent, agentHome: agent };
    expect(toolReadsOutsideText('doe', 'search', { query: 'secret' }, place)).toBe(false);
    const inside = { query: 'secret', path: '.dork/.temp/room-attachments' };
    expect(toolReadsOutsideText('doe', 'search', inside, place)).toBe(true);
  });

  it('counts them only once they are on disk or the line makes them', () => {
    const home = standIn(['agents/wren/.dork/.temp']);
    const agent = path.join(home, 'agents', 'wren');
    const place = { cwd: agent, agentHome: agent };
    expect(marksIn(agent, 'grep -r secret .')).toBe(false);
    expect(toolReadsOutsideText('claude-code', 'Grep', { pattern: 'secret' }, place)).toBe(false);
    expect(marksIn(agent, 'mkdir -p .dork/.temp/room-attachments/e2 && grep -r secret .')).toBe(
      true
    );
  });
});

describe('room attachments behind the ignore file written beside them', () => {
  const ignored = (text = 'room-attachments/\n'): string => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', '');
    const home = standIn(['agents/wren/.dork/.temp/room-attachments/e1']);
    const agent = path.join(home, 'agents', 'wren');
    writeFileSync(path.join(agent, '.dork', '.temp', '.rgignore'), text);
    return agent;
  };
  const grepTool = (agent: string, input: Record<string, unknown> = { pattern: 'secret' }) =>
    toolReadsOutsideText('claude-code', 'Grep', input, { cwd: agent, agentHome: agent });

  it.each([
    'rg --hidden secret',
    'rg --hidden secret .dork/.temp',
    'rg -g "*.txt" --hidden secret',
    'rg --glob="**/*.{md,txt}" -g "!dist" --hidden secret',
    'rg --no-config --hidden secret',
  ])('%s honours it', (command) => {
    expect(marksIn(ignored(), command)).toBe(false);
  });

  it('the search tools built on rg honour it', () => {
    const agent = ignored();
    const place = { cwd: agent, agentHome: agent };
    expect(grepTool(agent)).toBe(false);
    expect(grepTool(agent, { pattern: 'secret', glob: '*.{ts,tsx}' })).toBe(false);
    expect(toolReadsOutsideText('opencode', 'grep', { pattern: 'secret' }, place)).toBe(false);
  });

  it.each([
    'rg -u --hidden secret',
    'rg -uu secret',
    'rg --no-ignore --hidden secret',
    'rg --hidden secret .dork/.temp/room-attachments',
    'rg --hidden -g "*" secret',
    'rg --hidden --glob "**" secret',
    'rg --hidden --iglob=src/** secret',
    'RIPGREP_CONFIG_PATH=/made-up/rgrc rg --hidden secret',
    'grep -r secret .',
    'find . -name "*.txt"',
  ])('%s still reaches them', (command) => {
    expect(marksIn(ignored(), command)).toBe(true);
  });

  it('a ripgrep config named in the environment reaches them unless rg is told to skip it', () => {
    const agent = ignored();
    vi.stubEnv('RIPGREP_CONFIG_PATH', '/made-up/rgrc');
    expect(marksIn(agent, 'rg --hidden secret')).toBe(true);
    expect(marksIn(agent, 'rg --no-config --hidden secret')).toBe(false);
  });

  it('a search tool given a glob that includes paths still reaches them', () => {
    const agent = ignored();
    const place = { cwd: agent, agentHome: agent };
    expect(grepTool(agent, { pattern: 'secret', glob: '*' })).toBe(true);
    expect(grepTool(agent, { pattern: 'secret', glob: '**' })).toBe(true);
    const include = { pattern: 'secret', include: '*' };
    expect(toolReadsOutsideText('opencode', 'grep', include, place)).toBe(true);
  });

  it('a Grep pointed into the folder still reaches them', () => {
    expect(grepTool(ignored(), { pattern: 'x', path: '.dork/.temp/room-attachments' })).toBe(true);
  });

  it('counts only an ignore file holding exactly that line', () => {
    expect(grepTool(ignored('room-attachments/\n!room-attachments/\n'))).toBe(true);
  });
});

describe('where a search starts', () => {
  it.each([
    'find -x ~ -name invoice.txt',
    'find -E ~ -name invoice.txt',
    'find -s -X ~ -name invoice.txt',
    'find -f ~ -name invoice.txt',
    'find -d ~ -type f',
  ])('%s, with BSD flags first, reaches the Downloads folder', (command) => {
    const home = standIn(['Downloads', 'projects']);
    expect(marksIn(path.join(home, 'projects'), command)).toBe(true);
    expect(marksIn(path.join(home, 'projects'), command.replace('~', '.'))).toBe(false);
  });

  it.each([
    'grep -d recurse invoice ~',
    'grep --directories=recurse invoice ~',
    'grep --directories recurse invoice',
    'rg -t md invoice',
    'rg -g "*.txt" invoice',
    'rg --max-depth 3 invoice',
    'grep -rn -e invoice -e total',
    'grep -r -m 1 invoice',
    'ag -G txt invoice',
    'fd -e txt invoice',
  ])('%s reaches the Downloads folder', (command) => {
    const home = standIn(['Downloads']);
    expect(marksIn(home, command)).toBe(true);
  });

  it.each(['grep -d skip invoice ~', 'grep invoice ~', 'fd -x cat {} invoice'])(
    '%s does not search the tree',
    (command) => {
      const home = standIn(['Downloads', 'projects']);
      expect(marksIn(path.join(home, 'projects'), command)).toBe(false);
    }
  );

  it('find -L among BSD flags follows links', () => {
    const home = standIn(['projects/app', 'Downloads']);
    const project = path.join(home, 'projects', 'app');
    symlinkSync(path.join(home, 'Downloads'), path.join(project, 'inbox'));
    expect(marksIn(project, 'find -xL . -name x')).toBe(true);
    expect(marksIn(project, 'find -x . -name x')).toBe(false);
  });
});

describe('a wildcard root', () => {
  it('counts a folder of outside files only once it is on disk', () => {
    const home = standIn(['projects/app/apps/web/.temp'], 'HOME/projects/app/apps/web/.temp/.dork');
    const project = path.join(home, 'projects', 'app');
    expect(marksIn(project, 'grep -rn TODO apps/*')).toBe(false);
    mkdirSync(path.join(project, 'apps', 'web', '.temp', '.dork', 'rooms'), { recursive: true });
    expect(marksIn(project, 'grep -rn TODO apps/*')).toBe(true);
  });

  it('a search that leaves hidden folders out does not reach one below the pattern', () => {
    const home = standIn(
      ['projects/app/apps/web/.temp/.dork/rooms'],
      'HOME/projects/app/apps/web/.temp/.dork'
    );
    const project = path.join(home, 'projects', 'app');
    expect(marksIn(project, 'rg TODO apps/*')).toBe(false);
    expect(marksIn(project, 'rg --hidden TODO apps/*')).toBe(true);
  });

  it('a wildcard opens no hidden name it does not spell', () => {
    const home = standIn(['projects/app/.temp/.dork/rooms'], 'HOME/projects/app/.temp/.dork');
    const project = path.join(home, 'projects', 'app');
    expect(marksIn(project, 'grep -rn TODO ./*')).toBe(false);
    expect(marksIn(project, 'grep -rn TODO ./.t*')).toBe(true);
  });
});

describe('a quoted variable followed by more of the path', () => {
  it('reads the variable apart from the text after it', () => {
    const home = standIn(['projects']);
    vi.stubEnv('TMPDIR', `${os.tmpdir()}${path.sep}`);
    expect(marksIn(path.join(home, 'projects'), 'cat "$TMPDIR"page.html')).toBe(true);
    expect(marksIn(path.join(home, 'projects'), 'cat "$HOME"notes.md')).toBe(false);
  });
});
