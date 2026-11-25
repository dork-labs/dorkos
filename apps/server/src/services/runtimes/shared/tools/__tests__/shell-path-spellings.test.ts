/**
 * How a shell command spells a path in a folder of outside files (DOR-5240): after its `cd`s, its
 * variables and `for` lists, and its wildcards, and which searches reach one below hidden folders
 * or through links.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';
import { madeUpHome } from './made-up-home.js';

const AGENT = '/agents/wren';
const PLACE = { cwd: AGENT, agentHome: AGENT };
const TEMP = os.tmpdir();
// A made-up home with a Downloads folder, so no test leans on the real home.
const { home: HOME, remove: removeHome } = madeUpHome(['Downloads']);
const marks = (command: string, place: object = PLACE) => commandReadsOutsideText(command, place);

beforeEach(() => {
  vi.stubEnv('HOME', HOME);
  vi.stubEnv('DORK_HOME', '/made-up/dork-home');
});
afterAll(() => {
  removeHome();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a path spelled through the shell marks', () => {
  it.each([
    ['a TMPDIR default', 'cat "${TMPDIR:-/tmp}/page.html"'],
    ['cd home, then a relative path', 'cd ~ && cat Downloads/invoice.txt'],
    ['cd with no folder, then a relative path', 'cd; cat Downloads/invoice.txt'],
    ['cd by $HOME', 'cd "$HOME"; head Downloads/invoice.txt'],
    ['a wildcard in the folder name', 'cat ~/Down*/invoice.txt'],
    ['a one-letter wildcard', 'cat ~/Downloa?s/invoice.txt'],
    ['a wildcard for the whole folder', 'cat ~/*/invoice.txt'],
    ['a wildcard under the temp folder', 'cat /tmp/*.html'],
    ['a for list', 'for d in Downloads Desktop; do cat ~/$d/invoice.txt; done'],
    ['braces', 'cat ~/{Desktop,Downloads}/invoice.txt'],
    ['a variable set first', 'D=~/Downloads; cat $D/invoice.txt'],
  ])('%s', (_name, command) => {
    expect(marks(command)).toBe(true);
  });

  it('TMPDIR as the shell has it, trailing slash and all', () => {
    vi.stubEnv('TMPDIR', `${TEMP}/`);
    expect(marks('cat ${TMPDIR}page.html')).toBe(true);
    expect(marks('cat "${TMPDIR}"page.html')).toBe(true);
  });

  it.each([
    'cd src && cat index.ts',
    'cat src/*.ts',
    'ls **/*.md',
    'cd ~/made-up-project && git status',
    'for f in a.md b.md; do cat $f; done',
    'D=docs; cat $D/guide.md',
  ])('%s stays local', (command) => {
    expect(marks(command)).toBe(false);
  });

  it('a wildcard path inside a working folder in the temp folder stays local', () => {
    const cwd = path.join(TEMP, 'made-up-project');
    expect(marks('cat notes/*.md', { cwd, agentHome: cwd })).toBe(false);
    expect(marks('cat ../*/page.html', { cwd, agentHome: cwd })).toBe(true);
  });
});

describe('where a search starts', () => {
  it('find with no folder starts where it stands', () => {
    expect(marks('find -name invoice.txt', { cwd: HOME, agentHome: HOME })).toBe(true);
    expect(marks('find -L -name invoice.txt', { cwd: HOME, agentHome: HOME })).toBe(true);
    expect(marks('find src -name invoice.txt', { cwd: HOME, agentHome: HOME })).toBe(false);
    expect(marks('find -name "*.ts"')).toBe(false);
  });

  it('find after cd searches the folder it went to', () => {
    expect(marks('cd ~ && find . -name invoice.txt')).toBe(true);
  });

  it('a wildcard root reaches the folders it could name', () => {
    expect(marks('grep -r invoice ~/D*')).toBe(true);
    expect(marks('rg invoice ~/Do*')).toBe(true);
    expect(marks('rg invoice src/*')).toBe(false);
  });
});

describe('hidden folders on the way to outside files', () => {
  // The data folder kept inside the working folder, under hidden folders, as in development.
  const project = mkdtempSync(path.join(TEMP, 'made-up-data-'));
  const place = { cwd: project, agentHome: project };
  mkdirSync(path.join(project, '.temp', '.dork', 'rooms'), { recursive: true });
  beforeEach(() => {
    vi.stubEnv('DORK_HOME', path.join(project, '.temp', '.dork'));
  });
  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it.each(['grep -rn invoice .', 'grep -R invoice', 'find . -name "*.txt"', 'find -type f'])(
    '%s enters them, so it marks',
    (command) => {
      expect(marks(command, place)).toBe(true);
    }
  );

  it.each(['rg invoice .', 'ag invoice', 'ack invoice', 'fd invoice', 'grep -rn invoice src'])(
    '%s does not reach the data folder',
    (command) => {
      expect(marks(command, place)).toBe(false);
    }
  );

  it.each(['rg --hidden invoice .', 'rg -uu invoice', 'fd -H invoice', 'ag --hidden invoice'])(
    '%s searches hidden folders, so it marks',
    (command) => {
      expect(marks(command, place)).toBe(true);
    }
  );

  it('a search on the line after a heredoc is read on its own', () => {
    expect(marks("cat > notes.md <<'EOF'\nhi\nEOF\ngrep -rn invoice .", place)).toBe(true);
  });

  it('counts a data folder below the root once it is on disk', () => {
    vi.stubEnv('DORK_HOME', path.join(project, '.other', '.dork'));
    expect(marks('grep -rn invoice .', place)).toBe(false);
    mkdirSync(path.join(project, '.other', '.dork', 'rooms'), { recursive: true });
    expect(marks('grep -rn invoice .', place)).toBe(true);
  });
});

describe('a search that follows links', () => {
  const project = mkdtempSync(path.join(TEMP, 'made-up-links-'));
  const place = { cwd: project, agentHome: project };
  const elsewhere = mkdtempSync(path.join(TEMP, 'made-up-elsewhere-'));
  mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
  symlinkSync(elsewhere, path.join(project, 'src', 'deep', 'linked'));
  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it.each(['grep -R invoice .', 'grep -rR invoice src', 'rg -L invoice', 'find -L . -name x'])(
    '%s reaches the temp folder through a link',
    (command) => {
      expect(marks(command, place)).toBe(true);
    }
  );

  it.each(['grep -r invoice .', 'rg invoice', 'find . -name x'])(
    '%s does not follow the link',
    (command) => {
      expect(marks(command, place)).toBe(false);
    }
  );
});
