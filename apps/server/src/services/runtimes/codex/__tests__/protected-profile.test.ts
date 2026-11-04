import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';
import { buildLoadOverrides } from '../app-server/thread-loader.js';
import { PROTECTED_PATHS } from '../../shared/policy/protected-paths.js';

// This matrix pins rendering when all literal components exist. Missing-path
// behavior is exercised against a real throwaway tree in its dedicated suite.
beforeEach(() => {
  vi.spyOn(fs, 'lstatSync').mockReturnValue({} as fs.Stats);
  vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

const roots = {
  cwd: '/probe/desk',
  data: '/probe/data',
  home: '/probe/home',
  accounts: ['/probe/account'],
  agentFolders: ['/probe/desk'],
  agentHomes: ['/probe/agent'],
};
const filePolicy = { roots, writable: ['/probe/extra'] };
const tools = {
  agentTokenEnv: {},
  managed: { servers: {}, env: {} },
  dorkosTools: null,
  connectorTools: null,
  filePolicy,
};

describe.each(['default', 'acceptEdits', 'bypassPermissions'])(
  'Codex protected files at %s',
  (permissionMode) => {
    it('selects the same profile on start/resume without a legacy sandbox option', () => {
      const settings = { permissionMode };
      const load = buildLoadOverrides(
        { cwd: roots.cwd, settings, tools },
        { threadKey: undefined, trust: undefined, realCwd: roots.cwd }
      );
      expect(load.permissions).toBe(codexPermissionProfile(settings));
      expect(load).not.toHaveProperty('sandbox');
      expect(load.config).toMatchObject(
        codexProtectedConfig(roots.cwd, filePolicy, { permissionMode })
      );
    });

    it('keeps secret reads and person-only writes refused even at Full', () => {
      const config = codexProtectedConfig(roots.cwd, filePolicy, { permissionMode });
      const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
      const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
      expect(files['/probe/data/host.key']).toBe('deny');
      expect(files['/probe/data/config.json']).toBe('deny');
      expect(files['/probe/home/.dork/config.json']).toBe('deny');
      expect(files['/probe/home/.claude.json']).toBe('deny');
      expect(files['/probe/data/permissions']).toBe('read');
      expect(files['/probe/agent/.dork/agent.json']).toBe('read');
      expect(files).not.toHaveProperty('/probe/data/agents/*/.dork/agent.json');
      expect(files['/probe/desk/**/.env']).toBe('deny');
      expect(files['/probe/home/**/.dork/plugins/**']).toBe('deny');
      expect(files).not.toHaveProperty('/probe/data/agents/*/.agents/**');
      expect(files['/probe/agent/.agents']).toBe('read');
    });

    it('renders every glob with a ripgrep suffix that survives an absolute search root', () => {
      const config = codexProtectedConfig(roots.cwd, filePolicy, { permissionMode });
      const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
      const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
      // Mirror Codex 0.163's split_pattern_for_ripgrep: the directory
      // before the first metacharacter is passed as an absolute search root.
      const offenders = Object.keys(files).flatMap((file) => {
        const first = file.search(/[*?[\]]/);
        if (first < 0) return [];
        const prefix = file.slice(0, first);
        const end = prefix.endsWith('/') ? prefix.length - 1 : prefix.lastIndexOf('/');
        const suffix = file.slice(end + 1);
        return suffix.includes('/') && !suffix.startsWith('**/') ? [{ file, suffix }] : [];
      });
      expect(offenders).toEqual([]);
    });

    it('prefixes every anywhere rule because bubblewrap refuses root /** globs', () => {
      const config = codexProtectedConfig(roots.cwd, filePolicy, { permissionMode });
      const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
      const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
      expect(Object.keys(files).some((file) => file.startsWith('/**'))).toBe(false);
      for (const prefix of [
        roots.home,
        roots.data,
        roots.cwd,
        ...filePolicy.writable,
        ...roots.agentFolders,
        ...roots.agentHomes,
        ...roots.accounts,
      ]) {
        for (const entry of PROTECTED_PATHS.filter((entry) => entry.root === 'anywhere')) {
          expect(files[`${prefix}/**/${entry.path}`]).toBe('deny');
          if (entry.kind === 'folder') expect(files[`${prefix}/**/${entry.path}/**`]).toBe('deny');
        }
      }
    });

    it('fails closed instead of dropping rules for a filesystem-root prefix', () => {
      expect(() =>
        codexProtectedConfig(
          '/',
          { ...filePolicy, roots: { ...roots, cwd: '/' } },
          { permissionMode }
        )
      ).toThrow('Choose a folder inside it');
    });

    it('overrides only root-level automatic metadata masks, only at Full', () => {
      const config = codexProtectedConfig(roots.cwd, filePolicy, { permissionMode });
      const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
      const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
      const names = ['.git', '.agents', '.codex', '.aws'];
      const metadata = names.map((name) => path.join(path.parse(roots.cwd).root, name));
      for (const file of metadata) {
        if (permissionMode === 'bypassPermissions') expect(files[file]).toBe('write');
        else expect(files).not.toHaveProperty(file);
      }
      expect(Object.keys(files).filter((file) => files[file] === 'write')).toEqual(
        permissionMode === 'bypassPermissions' ? [':root', ...metadata] : []
      );
      for (const name of names) expect(files[path.join(roots.cwd, name)]).not.toBe('write');
    });
  }
);

describe('capturing agent homes', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions'])(
    'adds real unregistered folders as literal read-only homes at %s, without following links',
    (permissionMode) => {
      vi.restoreAllMocks();
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-literal-homes-')));
      try {
        const data = path.join(root, 'data');
        const agents = path.join(data, 'agents');
        const home = path.join(agents, 'unregistered');
        const outside = path.join(root, 'outside');
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(agents, 'linked'), 'dir');
        fs.writeFileSync(path.join(agents, 'regular-file'), '');
        const policy = { ...filePolicy, roots: { ...roots, data } };
        const config = codexProtectedConfig(roots.cwd, policy, { permissionMode });
        const profiles = config.permissions as Record<
          string,
          { filesystem: Record<string, string> }
        >;
        const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
        expect(files[path.join(home, '.claude', 'settings.json')]).toBe('read');
        expect(files[path.join(home, '.claude', 'skills')]).toBe('read');
        expect(files[path.join(home, '.agents')]).toBe('read');
        for (const ignored of ['linked', 'regular-file'])
          expect(
            Object.keys(files).some((file) => file.startsWith(path.join(agents, ignored)))
          ).toBe(false);
        expect(Object.keys(files).some((file) => file.startsWith(path.join(agents, '*')))).toBe(
          false
        );
        // Folder discovery must not expand or reshape any secret globs.
        expect(files[`${data}/**/.credentials*`]).toBe('deny');
        expect(files).not.toHaveProperty(`${home}/**/.credentials*`);

        const later = path.join(agents, 'created-after-render');
        expect(files).not.toHaveProperty(path.join(later, '.claude'));
        fs.mkdirSync(later);
        const next = codexProtectedConfig(roots.cwd, policy, { permissionMode });
        const nextProfiles = next.permissions as typeof profiles;
        // Missing descendants collapse at the first absent parent.
        expect(
          nextProfiles[codexPermissionProfile({ permissionMode })]!.filesystem[
            path.join(later, '.claude')
          ]
        ).toBe('read');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('allows an absent agents folder', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(() => codexProtectedConfig(roots.cwd, filePolicy)).not.toThrow();
  });

  it.each(['EACCES', 'ENOTDIR', 'EIO'])('refuses an agents-folder enumeration error %s', (code) => {
    const error = Object.assign(new Error('cannot enumerate'), { code });
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw error;
    });
    expect(() => codexProtectedConfig(roots.cwd, filePolicy)).toThrow(error);
  });
});
