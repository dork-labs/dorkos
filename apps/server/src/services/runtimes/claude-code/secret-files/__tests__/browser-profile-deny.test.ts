/** No agent file tool reaches a browser profile's sign-ins, or forges a binding (DOR-3218). */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { applyPersonOnlyDataDeny, personOnlyFileRules } from '../../messaging/directory-grants.js';
import { secretReadDenyRules } from '../secret-read-deny.js';

/** Whether a rule for this tool covers the file, by Claude Code's glob: `*` crosses folders. */
function denied(rules: readonly string[], tool: string, file: string): boolean {
  return rules.some((rule) => {
    const match = new RegExp(`^${tool}\\(/(/.+)\\)$`).exec(rule);
    if (!match) return false;
    const pattern = match[1]!.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
    return new RegExp(`^${pattern}$`).test(file);
  });
}

describe('browser profile deny rules', () => {
  let home: string;
  let readRules: string[];
  let writeRules: string[];
  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-deny-')));
    readRules = secretReadDenyRules({
      dorkHome: home,
      accountRoot: path.join(home, 'account'),
      otherAccountRoots: [],
    });
    const options = {} as Options;
    applyPersonOnlyDataDeny(options, home);
    const settings = options.settings as { permissions: { deny: string[] } };
    writeRules = [...settings.permissions.deny, ...personOnlyFileRules(home)];
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  const files = [
    'local-browser/saved-logins/Default/Cookies',
    'browser-profiles/default/Default/Cookies',
    'browser-profiles/00000000-0000-4000-8000-000000000001/Default/Cookies',
    'browser-profiles/.binding-key',
  ];

  describe.each(files)('%s', (file) => {
    it.each(['Read', 'Grep', 'Glob'])('refuses %s', (tool) => {
      expect(denied(readRules, tool, path.join(home, file))).toBe(true);
    });
    it('refuses Edit', () => {
      expect(denied(writeRules, 'Edit', path.join(home, file))).toBe(true);
    });
  });

  it.each(['dork.db', 'dork.db-wal', 'dorkos.db'])('refuses Edit on %s', (file) => {
    expect(denied(writeRules, 'Edit', path.join(home, file))).toBe(true);
  });
});
