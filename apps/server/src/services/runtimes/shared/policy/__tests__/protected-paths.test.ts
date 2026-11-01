import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_FOLDER_SECRET_PATHS,
  AGENT_FOLDER_SECRET_PATHS,
  AGENT_HOME_SELF_GRANT_PATHS,
  ANYWHERE_SECRET_PATHS,
  DATA_FOLDER_SECRET_PATHS,
  DATA_GRANT_FILE_PATHS,
  HOME_SECRET_PATHS,
  HOME_SELF_GRANT_PATHS,
  PERSON_ONLY_DATA_PATHS,
  PROJECT_PLUGIN_PATHS,
  PROTECTED_PATHS,
  protectedPathGlob,
  type ProtectedPath,
} from '../protected-paths.js';

const globs = (entries: readonly ProtectedPath[]) => entries.map(protectedPathGlob);

describe('protected paths', () => {
  it('is well formed: relative, no trailing glob on a folder, no duplicates', () => {
    for (const entry of PROTECTED_PATHS) {
      expect(entry.path).not.toMatch(/^[/~]/);
      expect(entry.path).not.toMatch(/\/$/);
      if (entry.kind === 'folder') expect(entry.path).not.toMatch(/\*\*$/);
      expect(['read', 'write']).toContain(entry.deny);
    }
    const keys = PROTECTED_PATHS.map((e) => `${e.root}|${e.deny}|${e.kind}|${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps secrets from reads and grant files from writes', () => {
    const reads = [
      DATA_FOLDER_SECRET_PATHS,
      ACCOUNT_FOLDER_SECRET_PATHS,
      ANYWHERE_SECRET_PATHS,
      HOME_SECRET_PATHS,
      AGENT_FOLDER_SECRET_PATHS,
    ].flat();
    const writes = [
      PERSON_ONLY_DATA_PATHS,
      DATA_GRANT_FILE_PATHS,
      PROJECT_PLUGIN_PATHS,
      AGENT_HOME_SELF_GRANT_PATHS,
      HOME_SELF_GRANT_PATHS,
    ].flat();
    expect(reads.every((e) => e.deny === 'read')).toBe(true);
    expect(writes.every((e) => e.deny === 'write')).toBe(true);
    expect(PROTECTED_PATHS).toHaveLength(reads.length + writes.length);
  });

  it('spells a folder with /** and a file as named', () => {
    expect(protectedPathGlob({ root: 'data', path: 'push', kind: 'folder', deny: 'read' })).toBe(
      'push/**'
    );
    expect(
      protectedPathGlob({ root: 'data', path: 'config.json*', kind: 'file', deny: 'read' })
    ).toBe('config.json*');
  });

  // The list is security policy for every runtime: a change here is a change in
  // what every agent can read or write, so it has to be made on purpose.
  it('pins the secret-read lists', () => {
    expect(globs(DATA_FOLDER_SECRET_PATHS)).toEqual([
      'host.key',
      'config.json*',
      'config-*.json.bak',
      'backups/**',
      'mcp-local-token',
      'better-auth-secret',
      'api-key',
      'dork*.db*',
      'relay/adapters.json',
      'push/**',
      'extension-secrets/**',
      'secrets/**',
      'browser/storage-state.json',
      'browser/profile/**',
      'browser-profiles/**',
      'local-browser/saved-logins/**',
    ]);
    expect(globs(ACCOUNT_FOLDER_SECRET_PATHS)).toEqual([
      '.credentials*',
      '.claude.json*',
      'backups/**',
    ]);
    expect(globs(ANYWHERE_SECRET_PATHS)).toEqual([
      '.credentials*',
      '.claude.json*',
      '.codex/auth.json',
      'opencode/auth.json',
    ]);
    expect(globs(HOME_SECRET_PATHS)).toEqual([
      '.ssh/**',
      '.aws/**',
      '.config/gh/hosts.yml',
      '.netrc',
      '.npmrc',
      '.docker/config.json',
      '.config/gcloud/**',
      '.claude.json*',
      '.claude/.credentials*',
      '.claude/backups/**',
      ...globs(DATA_FOLDER_SECRET_PATHS).map((glob) => `.dork/${glob}`),
    ]);
    expect(globs(AGENT_FOLDER_SECRET_PATHS)).toContain('.env');
    expect(globs(AGENT_FOLDER_SECRET_PATHS)).not.toContain('.env.example');
    expect(AGENT_FOLDER_SECRET_PATHS).toHaveLength(34);
  });

  it('pins the protected-write lists', () => {
    expect(globs(PERSON_ONLY_DATA_PATHS)).toEqual([
      'permissions/**',
      'session-relay/**',
      'extension-snapshots/**',
      'cache/extensions/**',
      'marketplace/**',
      'plugins/**',
      'config.json*',
      'config-*.json.bak',
      'marketplaces.json*',
    ]);
    expect(globs(DATA_GRANT_FILE_PATHS)).toEqual([
      'config.json',
      'host.key',
      'mcp-local-token',
      'better-auth-secret',
      'marketplaces.json',
    ]);
    expect(globs(PROJECT_PLUGIN_PATHS)).toEqual(['.dork/plugins/**']);
    expect(globs(AGENT_HOME_SELF_GRANT_PATHS)).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/skills/**',
      '.claude/commands/**',
      '.claude/agents/**',
      '.agents/**',
      '.mcp.json',
      '.dork/agent.json',
    ]);
    expect(globs(HOME_SELF_GRANT_PATHS)).toEqual([
      '.claude/**',
      '.claude.json',
      '.dork/config.json',
      '.dork/host.key',
      '.dork/mcp-local-token',
      '.dork/better-auth-secret',
      '.dork/marketplaces.json',
    ]);
  });
});
