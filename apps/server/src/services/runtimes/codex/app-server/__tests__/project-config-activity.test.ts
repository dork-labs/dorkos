/**
 * DOR-4408: at Full, DorkOS trusts a folder and Codex loads its own
 * `.codex/config.toml`, so the person gets one Activity line saying so. Made-up
 * repos in a throwaway folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTrust } from '../thread-trust.js';
import {
  forgetProjectConfigActivity,
  setProjectConfigActivity,
  type ProjectConfigActivityEntry,
} from '../project-config-activity.js';

let root: string;
let lines: ProjectConfigActivityEntry[];

/** A made-up cloned repo, with or without its own Codex settings. */
function repo(name: string, config?: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), config);
  return dir;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4408-')));
  lines = [];
  setProjectConfigActivity((entry) => lines.push(entry));
});

afterEach(() => {
  setProjectConfigActivity(undefined);
  forgetProjectConfigActivity();
  fs.rmSync(root, { recursive: true, force: true });
});

const SERVER = '[mcp_servers.sample]\ncommand = "/bin/echo"\n';

describe('a folder’s own Codex settings', () => {
  it('loads at Full and says so once, naming the file, never its content', () => {
    const dir = repo('sample-repo', SERVER);
    expect(loadTrust('person', 'danger-full-access', undefined, dir)).toBe('trusted');
    expect(loadTrust('person', 'danger-full-access', undefined, dir)).toBe('trusted');
    expect(lines).toEqual([
      {
        cwd: dir,
        summary: 'Codex loaded .codex/config.toml in sample-repo at Full.',
        files: [path.join(dir, '.codex', 'config.toml')],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('/bin/echo');
  });

  it('says it again when the file changes', () => {
    const dir = repo('sample-repo', SERVER);
    loadTrust('person', 'danger-full-access', undefined, dir);
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), `${SERVER}# changed\n`);
    loadTrust('person', 'danger-full-access', undefined, dir);
    expect(lines).toHaveLength(2);
  });

  it.each([
    ['Ask first', 'read-only', undefined],
    ['workspace write', 'workspace-write', 'untrusted'],
  ] as const)('does not load at %s, and says nothing', (_label, sandbox, trust) => {
    const dir = repo('sample-repo', SERVER);
    expect(loadTrust('person', sandbox, undefined, dir)).toBe(trust);
    expect(lines).toEqual([]);
  });

  it('follows a symlinked config, as Codex does, and names the link', () => {
    const real = path.join(root, 'shared-config.toml');
    fs.writeFileSync(real, SERVER);
    const dir = repo('linked-repo');
    fs.symlinkSync(real, path.join(dir, '.codex', 'config.toml'));
    loadTrust('person', 'danger-full-access', undefined, dir);
    expect(lines.map((l) => l.files)).toEqual([[path.join(dir, '.codex', 'config.toml')]]);
  });

  it('says nothing for a folder with no settings of its own', () => {
    expect(loadTrust('person', 'danger-full-access', undefined, repo('plain-repo'))).toBe(
      'trusted'
    );
    expect(lines).toEqual([]);
  });

  it('says nothing for a folder the person trusted in Codex themselves', () => {
    const dir = repo('sample-repo', SERVER);
    expect(loadTrust('person', 'workspace-write', 'trusted', dir)).toBe('trusted');
    expect(loadTrust('person', 'danger-full-access', 'trusted', dir)).toBe('trusted');
    expect(lines).toEqual([]);
  });

  it('never trusts a folder in the credits home', () => {
    const dir = repo('sample-repo', SERVER);
    expect(loadTrust('credits', 'danger-full-access', undefined, dir)).toBe('untrusted');
    expect(lines).toEqual([]);
  });
});

describe('the folders Codex reads, up to the repo top (DOR-4410)', () => {
  /** A made-up repo with a `.git` at its top and a subfolder to open a chat in. */
  function gitRepo(topConfig?: string, subConfig?: string): { top: string; sub: string } {
    const top = repo('kestrel-repo', topConfig);
    fs.mkdirSync(path.join(top, '.git'));
    const sub = path.join(top, 'packages', 'northwind');
    fs.mkdirSync(path.join(sub, '.codex'), { recursive: true });
    if (subConfig !== undefined)
      fs.writeFileSync(path.join(sub, '.codex', 'config.toml'), subConfig);
    return { top, sub };
  }

  it('says so for a chat opened in a subfolder when the repo top has the file', () => {
    const { top, sub } = gitRepo(SERVER);
    loadTrust('person', 'danger-full-access', undefined, sub);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.files).toEqual([path.join(top, '.codex', 'config.toml')]);
  });

  it('names every file it finds, outermost first', () => {
    const { top, sub } = gitRepo(SERVER, SERVER);
    loadTrust('person', 'danger-full-access', undefined, sub);
    expect(lines[0]!.files).toEqual([
      path.join(top, '.codex', 'config.toml'),
      path.join(sub, '.codex', 'config.toml'),
    ]);
  });

  it('says it again when a parent folder’s file changes', () => {
    const { top, sub } = gitRepo(SERVER);
    loadTrust('person', 'danger-full-access', undefined, sub);
    fs.writeFileSync(path.join(top, '.codex', 'config.toml'), `${SERVER}# changed\n`);
    loadTrust('person', 'danger-full-access', undefined, sub);
    expect(lines).toHaveLength(2);
  });

  it('never looks above the repo top', () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), SERVER);
    const { sub } = gitRepo();
    loadTrust('person', 'danger-full-access', undefined, sub);
    expect(lines).toEqual([]);
  });
});
