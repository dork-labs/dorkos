/**
 * DOR-4410: the folders Codex trusts in the person's own settings are named in
 * one Activity line, once per install, and the settings file is never changed.
 * Throwaway Codex homes and made-up folders only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordTrustedFoldersNotice, trustedProjectsIn } from '../trusted-folders-notice.js';

const SETTINGS = [
  'model = "gpt-5"',
  '',
  '[projects."/demo/kestrel"]',
  'trust_level = "trusted"',
  '',
  "[projects.'/demo/northwind']",
  'trust_level = "untrusted"',
  '',
  '[projects."/demo/acme \\"search\\""] # a comment',
  "trust_level = 'trusted' # written by Codex",
  '',
  '[mcp_servers.sample]',
  'trust_level = "trusted"',
].join('\n');

describe('reading the trusted folders', () => {
  it('names only the folders marked trusted, in file order', () => {
    expect(trustedProjectsIn(SETTINGS)).toEqual(['/demo/kestrel', '/demo/acme "search"']);
  });

  it('names nothing in a file with no projects', () => {
    expect(trustedProjectsIn('model = "gpt-5"\n')).toEqual([]);
  });
});

describe('the one-time line', () => {
  let root: string;
  let home: string;
  let doneFile: string;
  const emit = vi.fn(async () => undefined);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dor4410-'));
    home = path.join(root, 'codex-home');
    fs.mkdirSync(home);
    doneFile = path.join(root, 'dork', 'runtimes', 'codex', 'trusted-folders-notice.json');
    emit.mockClear();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = () =>
    recordTrustedFoldersNotice({ homes: [home, home], doneFile, activity: { emit } });

  it('names the trusted folders once, and never changes the settings file', async () => {
    const file = path.join(home, 'config.toml');
    fs.writeFileSync(file, SETTINGS);
    const before = fs.readFileSync(file);

    expect(await run()).toEqual(['/demo/kestrel', '/demo/acme "search"']);
    expect(await run()).toBeNull();

    expect(emit).toHaveBeenCalledOnce();
    const entry = (emit.mock.calls[0] as unknown[])[0] as {
      summary: string;
      metadata: { folders: string[]; files: string[] };
    };
    expect(entry.summary).toBe('Codex trusts 2 folders in your settings. Review them in Codex.');
    expect(entry.metadata.folders).toEqual(['/demo/kestrel', '/demo/acme "search"']);
    expect(entry.metadata.files).toEqual([file]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('writes no line when nothing is trusted, and does not look again', async () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[projects."/demo/kestrel"]\ntrust_level = "untrusted"\n'
    );
    expect(await run()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(fs.existsSync(doneFile)).toBe(true);
  });

  it('reads a settings file kept elsewhere through a link, as a dotfiles repo does', async () => {
    const elsewhere = path.join(root, 'dotfiles-config.toml');
    fs.writeFileSync(elsewhere, SETTINGS);
    fs.symlinkSync(elsewhere, path.join(home, 'config.toml'));
    expect(await run()).toEqual(['/demo/kestrel', '/demo/acme "search"']);
  });

  it('copes with a home that has no settings file', async () => {
    expect(await run()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
});
