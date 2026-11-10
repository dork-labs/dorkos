import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';
import { buildLoadOverrides } from '../app-server/thread-loader.js';
import { PROTECTED_PATHS } from '../../shared/policy/protected-paths.js';
import { MARKETPLACE_INSTALL_SIBLING_MARKERS } from '@dorkos/shared/marketplace-schemas';

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

    it('names the selected profile as the config default, so a rebuild without the request keeps it', () => {
      const settings = { permissionMode };
      const config = codexProtectedConfig(roots.cwd, filePolicy, settings);
      const load = buildLoadOverrides(
        { cwd: roots.cwd, settings, tools },
        { threadKey: undefined, trust: undefined, realCwd: roots.cwd }
      );
      expect(config.default_permissions).toBe(codexPermissionProfile(settings));
      expect(Object.keys(config.permissions as object)).toEqual([config.default_permissions]);
      expect(load.config.default_permissions).toBe(load.permissions);
      expect(String(config.default_permissions)).not.toMatch(/^:/);
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

    // DOR-3613: the person's DorkOS sign-in and the agent browser's cookies.
    it('keeps the desktop app’s data and the agent browser’s cookies from reads, even at Full', () => {
      const config = codexProtectedConfig(roots.cwd, filePolicy, { permissionMode });
      const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
      const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
      for (const folder of [
        '/probe/home/Library/Application Support/DorkOS',
        '/probe/home/AppData/Roaming/DorkOS',
        '/probe/home/.config/DorkOS',
        '/probe/data/browser/profile',
        '/probe/data/browser-profiles',
        '/probe/data/local-browser/saved-logins',
        '/probe/home/.dork/browser/profile',
      ])
        expect(files[folder], folder).toBe('deny');
      expect(files['/probe/data/browser/storage-state.json']).toBe('deny');
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
        const copies = MARKETPLACE_INSTALL_SIBLING_MARKERS.map((marker) =>
          path.join(agents, `probe${marker}saved`)
        );
        for (const copy of copies) fs.mkdirSync(copy);
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
        for (const copy of copies) {
          expect(files[copy]).toBe('read');
          expect(files).not.toHaveProperty(path.join(copy, '.claude'));
          expect(files).not.toHaveProperty(path.join(copy, '.agents'));
        }
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

describe('an obstructing file in another agent home', () => {
  it.each(
    ['default', 'acceptEdits', 'bypassPermissions'].flatMap((permissionMode) =>
      ['.claude', '.dork'].map((name) => ({ permissionMode, name }))
    )
  )(
    'keeps A’s $name read-only for B, but refuses A, at $permissionMode',
    ({ permissionMode, name }) => {
      vi.restoreAllMocks();
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'codex-isolated-refusal-'))
      );
      try {
        const data = path.join(root, 'data');
        const home = path.join(root, 'home');
        const a = path.join(data, 'agents', 'a');
        const b = path.join(data, 'agents', 'b');
        const project = path.join(root, 'project');
        for (const dir of [a, b, home, project]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(a, name), 'PERSON-empty-looking-file');
        const policy = {
          roots: {
            cwd: project,
            home,
            data,
            accounts: [],
            agentFolders: [b, project],
            agentHomes: [b],
          },
          writable: [project, a],
        };
        const config = codexProtectedConfig(project, policy, { permissionMode });
        const profiles = config.permissions as Record<
          string,
          { filesystem: Record<string, string> }
        >;
        const files = profiles[codexPermissionProfile({ permissionMode })]!.filesystem;
        const blocked = path.join(a, name);
        expect(files[blocked]).toBe('read');
        expect(Object.keys(files).some((file) => file.startsWith(blocked + '/'))).toBe(false);
        expect(fs.readFileSync(blocked, 'utf8')).toBe('PERSON-empty-looking-file');
        // A's own home remains in agentFolders even when its cwd is elsewhere.
        expect(() =>
          codexProtectedConfig(
            project,
            {
              ...policy,
              roots: { ...policy.roots, agentFolders: [a, project], agentHomes: [a] },
            },
            { permissionMode }
          )
        ).toThrow(expect.objectContaining({ blockingPath: path.join(a, name) }));
        const alias = path.join(root, 'alias-a');
        fs.symlinkSync(a, alias);
        expect(() =>
          codexProtectedConfig(
            alias,
            {
              ...policy,
              roots: { ...policy.roots, cwd: alias, agentFolders: [alias], agentHomes: [a] },
            },
            { permissionMode }
          )
        ).toThrow(expect.objectContaining({ blockingPath: path.join(a, name) }));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
