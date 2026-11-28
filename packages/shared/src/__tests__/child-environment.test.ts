/**
 * The child kinds that are not agent runtimes (DOR-5481): project work sees
 * none of DorkOS's own names, `npm install` gets only its list, and a
 * self-restart gets the real environment whole.
 */
import { describe, expect, it } from 'vitest';
import { childEnvironment, childEnvironmentNames } from '../child-environment.js';

/** A real environment with the person's basics and every kind of DorkOS name. */
const REAL = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/fixture',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  SSH_AUTH_SOCK: '/tmp/fixture-agent.sock',
  HTTPS_PROXY: 'http://proxy.fixture:3128',
  npm_config_cache: '/home/fixture/.npm',
  ANTHROPIC_API_KEY: 'fixture-anthropic',
  NPM_TOKEN: 'fixture-npm-token',
  MCP_API_KEY: 'fixture-mcp',
  NANGO_ENCRYPTION_KEY: 'fixture-nango',
  NANGO_SECRET_KEY_DEV: 'fixture-nango-2',
  NGROK_AUTHTOKEN: 'fixture-ngrok',
  GITHUB_TOKEN: 'fixture-github',
  TUNNEL_AUTH: 'fixture-tunnel',
  BETTER_AUTH_SECRET: 'fixture-secret',
  COMMUNITY_DATABASE_URL: 'postgres://fixture',
  NODE_ENV: 'production',
  DORKOS_HUB_INSTANCE_KEY: 'fixture-hub',
  DORKOS_PORT: '4242',
  DORK_HOME: '/home/fixture/.dork',
};

const DORKOS_NAMES = [
  'MCP_API_KEY',
  'NANGO_ENCRYPTION_KEY',
  'NANGO_SECRET_KEY_DEV',
  'NGROK_AUTHTOKEN',
  'GITHUB_TOKEN',
  'TUNNEL_AUTH',
  'BETTER_AUTH_SECRET',
  'COMMUNITY_DATABASE_URL',
  'NODE_ENV',
  'DORKOS_HUB_INSTANCE_KEY',
  'DORKOS_PORT',
  'DORK_HOME',
];

describe('childEnvironment', () => {
  it.each(['project-work', 'git', 'browser'] as const)(
    '%s keeps the person’s environment and drops every name DorkOS owns',
    (kind) => {
      const env = childEnvironment(kind, { parent: REAL, platform: 'darwin' });
      for (const name of DORKOS_NAMES) expect(env, name).not.toHaveProperty(name);
      expect(env).toMatchObject({
        PATH: REAL.PATH,
        HOME: REAL.HOME,
        SHELL: REAL.SHELL,
        SSH_AUTH_SOCK: REAL.SSH_AUTH_SOCK,
        ANTHROPIC_API_KEY: REAL.ANTHROPIC_API_KEY,
      });
    }
  );

  it('drops DorkOS’s names whatever their case on Windows', () => {
    const env = childEnvironment('project-work', {
      parent: { Path: 'C:\\Windows', mcp_api_key: 'fixture', DorkOS_Port: '1' },
      platform: 'win32',
    });
    expect(env).toEqual({ Path: 'C:\\Windows' });
  });

  it('sets the caller’s own values last', () => {
    const env = childEnvironment('project-work', {
      parent: REAL,
      set: { TERM: 'xterm-256color', DORKOS_PORT: '6100' },
    });
    expect(env).toMatchObject({ TERM: 'xterm-256color', DORKOS_PORT: '6100' });
    expect(env).not.toHaveProperty('MCP_API_KEY');
  });

  it('npm-install gets only its list: no token, no DorkOS name', () => {
    const env = childEnvironment('npm-install', { parent: REAL });
    expect(env).toEqual({
      PATH: REAL.PATH,
      HOME: REAL.HOME,
      HTTPS_PROXY: REAL.HTTPS_PROXY,
      npm_config_cache: REAL.npm_config_cache,
    });
    const listed = new Set(childEnvironmentNames('npm-install'));
    for (const name of Object.keys(env)) expect(listed.has(name.toUpperCase()), name).toBe(true);
    for (const name of listed) expect(name).not.toMatch(/TOKEN|KEY|SECRET|AUTH|DORK/);
  });

  it('os-helper gets home, path and locale only', () => {
    expect(childEnvironment('os-helper', { parent: REAL })).toEqual({
      PATH: REAL.PATH,
      HOME: REAL.HOME,
      LANG: REAL.LANG,
    });
  });

  it('self-restart gets the real environment whole, as a copy', () => {
    const env = childEnvironment('self-restart', { parent: REAL });
    expect(env).toEqual(REAL);
    expect(env).not.toBe(REAL);
  });
});
