/**
 * A search reaches the folders of outside files that are on disk below its root, or that the same
 * command line makes first (DOR-5240). Each test stands in a made-up home, laid out as a computer,
 * a CI runner or the Docker image has it.
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';
import { madeUpHome } from './made-up-home.js';

const homes: Array<() => void> = [];
/** Stand in a made-up home holding these folders; the data folder is `~/.dork`, as in Docker. */
const standIn = (folders: readonly string[]): string => {
  const { home, remove } = madeUpHome(folders);
  homes.push(remove);
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', path.join(home, '.dork'));
  return home;
};
const marksIn = (cwd: string, command: string) =>
  commandReadsOutsideText(command, { cwd, agentHome: cwd });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const remove of homes.splice(0)) remove();
});

describe('a home with no folder of outside files in it', () => {
  it.each(['grep -r invoice ~', 'grep -rn invoice', 'rg invoice', 'find . -name invoice.txt'])(
    '%s reads nothing from outside',
    (command) => {
      const home = standIn(['projects/app', '.dork']);
      expect(marksIn(home, command)).toBe(false);
    }
  );

  it('a search of the whole disk reaches the temp folder', () => {
    const home = standIn([]);
    expect(marksIn(home, 'find / -name invoice.txt')).toBe(true);
    expect(marksIn(home, 'rg invoice /')).toBe(true);
  });
});

describe('a home with a Downloads folder', () => {
  it.each([
    'grep -r invoice ~',
    'grep -rn invoice',
    'rg invoice',
    'find . -name invoice.txt',
    'fd invoice ~',
  ])('%s reaches it', (command) => {
    const home = standIn(['Downloads']);
    expect(marksIn(home, command)).toBe(true);
  });

  it('a search of a project in the home does not', () => {
    const home = standIn(['Downloads', 'projects/app']);
    expect(marksIn(path.join(home, 'projects', 'app'), 'grep -rn invoice .')).toBe(false);
  });
});

describe('the data folder in the home, as in the Docker image', () => {
  it.each(['grep -r invoice ~', 'find ~ -name invoice.txt', 'rg --hidden invoice ~'])(
    '%s reaches its rooms',
    (command) => {
      const home = standIn(['.dork/rooms']);
      expect(marksIn(home, command)).toBe(true);
    }
  );

  it('rg and fd leave the hidden data folder out', () => {
    const home = standIn(['.dork/rooms']);
    expect(marksIn(home, 'rg invoice ~')).toBe(false);
    expect(marksIn(home, 'fd invoice ~')).toBe(false);
  });
});

describe('a link below the root to a folder of outside files', () => {
  const linked = (): string => {
    const home = standIn(['projects/app/src', 'Downloads']);
    const project = path.join(home, 'projects', 'app');
    symlinkSync(path.join(home, 'Downloads'), path.join(project, 'src', 'inbox'));
    return project;
  };

  it.each(['grep -R invoice .', 'rg -L invoice', 'find -L . -name invoice.txt'])(
    '%s follows it',
    (command) => {
      expect(marksIn(linked(), command)).toBe(true);
    }
  );

  it.each(['grep -r invoice .', 'rg invoice', 'find . -name invoice.txt'])(
    '%s does not go through it',
    (command) => {
      expect(marksIn(linked(), command)).toBe(false);
    }
  );
});

describe('a folder of outside files the same line makes first', () => {
  it.each([
    'mkdir -p ~/Downloads && grep -r invoice ~',
    'mkdir ~/Downloads; rg invoice ~',
    'cp -r /made-up/files ~/Downloads && grep -r invoice ~',
    'mv /made-up/files ~/Downloads; find ~ -name invoice.txt',
    'ln -s /made-up/files ~/Downloads && grep -rn invoice ~',
    'mkdir -p ~/Downloads/new && grep -r invoice ~',
    'cp -r /made-up/files/Downloads ~ && grep -r invoice ~',
    'mv /made-up/files/Downloads ~/; rg invoice ~',
    'rsync -a /made-up/files/Downloads ~ && grep -r invoice ~',
    'tar -xf /made-up/files.tar -C ~ && grep -r invoice ~',
    'unzip -q /made-up/files.zip -d ~; rg invoice ~',
    'cd ~ && tar xf /made-up/files.tar && find . -name invoice.txt',
  ])('%s counts it as there', (command) => {
    const home = standIn([]);
    expect(marksIn(home, command)).toBe(true);
  });

  it('a folder made elsewhere does not', () => {
    const home = standIn([]);
    expect(marksIn(home, 'mkdir -p ~/projects/new && grep -r invoice ~')).toBe(false);
    expect(marksIn(home, 'cp -r /made-up/files/notes ~ && grep -r invoice ~')).toBe(false);
    expect(marksIn(home, 'tar -xf /made-up/files.tar -C ~/projects && grep -r invoice ~')).toBe(
      false
    );
  });
});

describe('the download folder XDG_DOWNLOAD_DIR names', () => {
  it('is a folder of outside files', () => {
    const home = standIn(['Téléchargements']);
    vi.stubEnv('XDG_DOWNLOAD_DIR', path.join(home, 'Téléchargements'));
    expect(marksIn(home, 'grep -r invoice ~')).toBe(true);
    expect(marksIn(home, 'cat ~/Téléchargements/facture.txt')).toBe(true);
  });

  it('naming the home itself adds nothing', () => {
    const home = standIn(['projects']);
    vi.stubEnv('XDG_DOWNLOAD_DIR', home);
    expect(marksIn(home, 'cat projects/notes.md')).toBe(false);
  });
});

describe('a file not there yet', () => {
  it('is read where its folder resolves', () => {
    const home = standIn(['projects/app']);
    const project = path.join(home, 'projects', 'app');
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'made-up-inbox-'));
    homes.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    symlinkSync(elsewhere, path.join(project, 'inbox'));
    expect(marksIn(project, 'cat inbox/new.txt')).toBe(true);
    expect(marksIn(project, 'cat notes/new.txt')).toBe(false);
  });
});
