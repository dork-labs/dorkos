/**
 * The one protected-file deny every DorkOS tool that opens, reads or copies a
 * local file asks (DOR-4060): the protected-files list on the real path, and a
 * refusal for any file with more than one hard link.
 *
 * Real files in a throwaway home with dummy values only: HOME, DORK_HOME and
 * CLAUDE_CONFIG_DIR all point inside it, so nothing reads the real ones.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkedFileRefusal,
  protectedPathRefusal,
  protectedSourceRefusal,
} from '../protected-file-guard.js';

const CANARY = 'TOKEN=dor-4060-dummy-canary';

let root: string;
let home: string;
let dork: string;
let agent: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4060-guard-')));
  home = path.join(root, 'home');
  dork = path.join(home, '.dork');
  agent = path.join(root, 'agents', 'qa');
  for (const dir of [path.join(dork, 'extension-secrets'), agent, path.join(root, 'claude')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dork, 'host.key'), CANARY);
  fs.writeFileSync(path.join(dork, 'config.json'), '{}');
  fs.writeFileSync(path.join(dork, 'dork.db'), '');
  fs.writeFileSync(path.join(dork, 'extension-secrets', 'ext.json'), '{}');
  fs.writeFileSync(path.join(agent, 'notes.md'), 'notes ok');
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('protectedPathRefusal', () => {
  it.each(['host.key', 'config.json', 'dork.db', 'extension-secrets/ext.json'])(
    'refuses %s named by its bare path from a chat in the data folder',
    (name) => {
      expect(protectedPathRefusal(name, dork)?.code).toBe('PROTECTED_FILE');
    }
  );

  it('refuses host.key from a chat in the home folder', () => {
    const refusal = protectedPathRefusal('.dork/host.key', home);
    expect(refusal?.code).toBe('PROTECTED_FILE');
    expect(refusal?.message).toBe(
      "host.key is a protected file, so DorkOS tools can't open or share it."
    );
  });

  it('refuses a symlink to host.key inside the agent’s own folder', () => {
    fs.symlinkSync(path.join(dork, 'host.key'), path.join(agent, 'innocent.txt'));
    expect(protectedPathRefusal('innocent.txt', agent)?.code).toBe('PROTECTED_FILE');
  });

  it('refuses a folder secret inside one of the extra folders it is given', () => {
    const copy = path.join(root, 'room-copy');
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, '.env'), 'X=dummy');
    expect(protectedPathRefusal(path.join(copy, '.env'), agent)).toBeNull();
    expect(protectedPathRefusal(path.join(copy, '.env'), agent, [copy])?.code).toBe(
      'PROTECTED_FILE'
    );
  });

  it('fails closed on a path it cannot check', () => {
    expect(protectedPathRefusal('bad\0name', agent)?.code).toBe('PROTECTED_FILE');
  });

  it('lets a plain file in the agent’s own folder through', () => {
    expect(protectedPathRefusal('notes.md', agent)).toBeNull();
  });
});

describe('a hard link', () => {
  it('has nothing on its path that says what it is, so only its link count refuses it', () => {
    const link = path.join(agent, 'hk-link.txt');
    fs.linkSync(path.join(dork, 'host.key'), link);
    expect(protectedPathRefusal(link, agent)).toBeNull();
    const refusal = linkedFileRefusal(fs.statSync(link), link);
    expect(refusal?.code).toBe('LINKED_FILE');
    expect(refusal?.message).toMatch(/^hk-link\.txt has more than one hard link/);
    expect(protectedSourceRefusal('hk-link.txt', agent)?.code).toBe('LINKED_FILE');
  });

  it('leaves a file with one link, and any folder, alone', () => {
    expect(linkedFileRefusal(fs.statSync(path.join(agent, 'notes.md')), 'notes.md')).toBeNull();
    expect(linkedFileRefusal({ isFile: () => false, nlink: 3 }, agent)).toBeNull();
  });
});

describe('protectedSourceRefusal', () => {
  it('refuses by path first, and passes a file that is not there yet', () => {
    expect(protectedSourceRefusal('host.key', dork)?.code).toBe('PROTECTED_FILE');
    expect(protectedSourceRefusal('not-yet.md', agent)).toBeNull();
    expect(protectedSourceRefusal('notes.md', agent)).toBeNull();
  });
});
