/**
 * Finding the Claude account folders on this computer (spec
 * `claude-account-ui` §7.4). Every case builds a temp home and passes it,
 * with the carve-out's listing of it, as `deps`, so nothing here ever looks at
 * a real home folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findUnregisteredClaudeFolders,
  planDismissFoundFolder,
  MAX_DISMISSED_FOLDERS,
} from '../found-claude-folders.js';
import { listClaudeAccountFolderCandidates } from '../../claude-config-dir.js';

let home: string;
let elsewhere: string;

/** Make `<home>/<name>` with the given sub-folders. */
function folder(name: string, ...subfolders: string[]): string {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of subfolders) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

/** A config whose Claude Code block is `claudeCode`. */
function config(claudeCode: Record<string, unknown> = {}): unknown {
  return { runtimes: { claudeCode: { defaultAccount: null, accounts: [], ...claudeCode } } };
}

/** The finder's inputs for the temp home, listed the way the carve-out lists the real one. */
function deps(dir: string = home) {
  return { home: dir, candidates: listClaudeAccountFolderCandidates(dir) };
}

function names(cfg: unknown = config()): string[] {
  return findUnregisteredClaudeFolders(cfg, deps()).map((f) => f.name);
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dork-found-home-')));
  elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dork-found-else-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

describe('findUnregisteredClaudeFolders', () => {
  it('finds a .claude2 folder holding projects/, with its path and name', () => {
    const dir = folder('.claude2', 'projects');

    const found = findUnregisteredClaudeFolders(config(), deps());

    expect(found).toEqual([
      {
        path: dir,
        name: '.claude2',
        lastUsedAt: expect.any(String),
        orgManaged: false,
        orgMarker: null,
      },
    ]);
  });

  it('ignores a folder holding only sessions/, and anything not named .claude*', () => {
    folder('.claude-sessions', 'sessions');
    folder('.claude-empty');
    folder('claude4', 'projects');
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    folder('.claude5', 'projects');

    expect(names()).toEqual(['.claude5']);
  });

  it('offers .claude when it is not the machine default, and hides it when it is', () => {
    folder('.claude', 'projects');
    const other = folder('.claude2', 'projects');

    // No default chosen: ~/.claude IS the machine default account.
    expect(names()).toEqual(['.claude2']);
    // The default points elsewhere, so ~/.claude is just another folder.
    expect(names(config({ defaultAccount: other }))).toEqual(['.claude']);
  });

  it('hides a registered folder, also when it is registered through a symlink', () => {
    const direct = folder('.claude2', 'projects');
    folder('.claude3', 'projects');
    const link = path.join(elsewhere, 'work-account');
    fs.symlinkSync(path.join(home, '.claude3'), link);
    folder('.claude4', 'projects');

    const cfg = config({
      accounts: [
        { id: 'direct', path: direct, label: null },
        { id: 'linked', path: link, label: 'Work' },
      ],
    });

    expect(names(cfg)).toEqual(['.claude4']);
  });

  it('hides a registered row the reader skips, when it carries a path', () => {
    folder('.claude2', 'projects');
    // `~` is not absolute, so the account reader skips this row; it still names the folder.
    expect(names(config({ accounts: [{ path: '~/.claude2', label: null }] }))).toEqual([]);
  });

  it('offers a symlinked .claude* folder once', () => {
    folder('.claude2', 'projects');
    fs.symlinkSync(path.join(home, '.claude2'), path.join(home, '.claude2-link'));

    expect(names()).toEqual(['.claude2']);
  });

  it('hides a dismissed folder', () => {
    const dir = folder('.claude2', 'projects');
    folder('.claude3', 'projects');

    expect(names(config({ dismissedFolders: [dir] }))).toEqual(['.claude3']);
  });

  it.each(['remote-settings.json', 'policy-limits.json'])(
    'flags a folder holding %s as managed by an organization',
    (marker) => {
      const dir = folder('.claude-ab1', 'projects');
      fs.writeFileSync(path.join(dir, marker), '{}');

      expect(findUnregisteredClaudeFolders(config(), deps())).toMatchObject([
        { name: '.claude-ab1', orgManaged: true, orgMarker: marker },
      ]);
    }
  );

  it('does not flag a marker that is a folder, not a file', () => {
    folder('.claude-ab1', 'projects', 'remote-settings.json');
    expect(findUnregisteredClaudeFolders(config(), deps())).toMatchObject([
      { orgManaged: false, orgMarker: null },
    ]);
  });

  it('dates last use by the newest file inside a projects/ child, which a resumed session appends to', () => {
    const dir = folder('.claude2', 'projects/-Users-me-app');
    const transcript = path.join(dir, 'projects/-Users-me-app/session.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const old = new Date('2026-01-01T00:00:00.000Z');
    const appended = new Date('2026-09-20T10:00:00.000Z');
    for (const p of [path.join(dir, 'projects/-Users-me-app'), path.join(dir, 'projects')]) {
      fs.utimesSync(p, old, old);
    }
    // Appending to a file changes its time, not its folder's.
    fs.utimesSync(transcript, appended, appended);

    expect(findUnregisteredClaudeFolders(config(), deps())[0]!.lastUsedAt).toBe(
      appended.toISOString()
    );
  });

  it('never opens a file: it only lists folders and reads their times', () => {
    const dir = folder('.claude2', 'projects/-p');
    fs.writeFileSync(path.join(dir, 'remote-settings.json'), '{"secret":1}');
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"token":"x"}');
    fs.writeFileSync(path.join(dir, 'projects/-p/s.jsonl'), '{}\n');
    const spies = [
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'open'),
      vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs, 'createReadStream'),
      vi.spyOn(fs.promises, 'open'),
      vi.spyOn(fs.promises, 'readFile'),
    ];

    const found = findUnregisteredClaudeFolders(config(), deps());

    expect(found).toHaveLength(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('answers empty for a home that cannot be read', () => {
    expect(findUnregisteredClaudeFolders(config(), deps(path.join(home, 'missing')))).toEqual([]);
  });
});

describe('planDismissFoundFolder', () => {
  it('saves the stored list plus the folder in comparable form', () => {
    const dir = folder('.claude2', 'projects');
    fs.symlinkSync(dir, path.join(elsewhere, 'alias'));

    expect(
      planDismissFoundFolder(
        path.join(elsewhere, 'alias'),
        config({ dismissedFolders: ['/x'] }),
        deps()
      )
    ).toEqual({ outcome: 'save', dismissed: ['/x', dir] });
  });

  it('changes nothing for a folder that is already dismissed, registered or the default', () => {
    const dir = folder('.claude2', 'projects');
    const def = folder('.claude', 'projects');
    expect(planDismissFoundFolder(dir, config({ dismissedFolders: [dir] }), deps())).toEqual({
      outcome: 'unchanged',
    });
    expect(
      planDismissFoundFolder(
        dir,
        config({ accounts: [{ id: 'a', path: dir, label: null }] }),
        deps()
      )
    ).toEqual({ outcome: 'unchanged' });
    expect(planDismissFoundFolder(def, config(), deps())).toEqual({ outcome: 'unchanged' });
  });

  it('refuses a folder the list does not offer', () => {
    folder('.claude-sessions', 'sessions');
    expect(planDismissFoundFolder(path.join(home, '.claude-sessions'), config(), deps())).toEqual({
      outcome: 'not-a-candidate',
    });
    expect(planDismissFoundFolder('/etc', config(), deps())).toEqual({
      outcome: 'not-a-candidate',
    });
  });

  it(`keeps the newest ${MAX_DISMISSED_FOLDERS} dismissals`, () => {
    const dir = folder('.claude2', 'projects');
    const full = Array.from({ length: MAX_DISMISSED_FOLDERS }, (_, i) => `/old/${i}`);

    const plan = planDismissFoundFolder(dir, config({ dismissedFolders: full }), deps());

    expect(plan).toMatchObject({ outcome: 'save' });
    const dismissed = (plan as { dismissed: string[] }).dismissed;
    expect(dismissed).toHaveLength(MAX_DISMISSED_FOLDERS);
    expect(dismissed.at(-1)).toBe(dir);
    expect(dismissed[0]).toBe('/old/1');
  });
});
