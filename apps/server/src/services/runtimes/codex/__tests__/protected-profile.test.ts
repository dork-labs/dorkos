import { describe, expect, it } from 'vitest';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';
import { buildLoadOverrides } from '../app-server/thread-loader.js';

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
      expect(files['/probe/data/permissions']).toBe('read');
      expect(files['/probe/agent/.dork/agent.json']).toBe('read');
      expect(files['/probe/data/agents/*/.dork/agent.json']).toBe('deny');
      expect(files['/probe/desk/**/.env']).toBe('deny');
    });
  }
);
