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
      { cwd: dir, summary: 'Codex loaded .codex/config.toml in sample-repo at Full.' },
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
