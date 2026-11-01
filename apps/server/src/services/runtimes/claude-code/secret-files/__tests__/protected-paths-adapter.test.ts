/**
 * Claude Code's lists, built from the shared protected-path list (DOR-3594),
 * are exactly the literals they replaced: the move changes no rule.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_FOLDER_SECRETS,
  AGENT_FOLDER_SECRETS,
  ANYWHERE_SECRETS,
  DATA_FOLDER_SECRETS,
  HOME_SECRETS,
} from '../secret-read-deny.js';
import {
  agentHomesSelfGrantRules,
  PERSON_ONLY_DATA_FILES,
  PERSON_ONLY_DATA_FOLDERS,
  PROJECT_PLUGIN_DENY_RULES,
} from '../../messaging/directory-grants.js';
import { selfGrantDenyRules } from '../../folder-settings/apply-folder-allows.js';

const DATA = [
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
];

describe('Claude Code protected-path adapter', () => {
  it('builds the secret-read lists it had before', () => {
    expect([...DATA_FOLDER_SECRETS]).toEqual(DATA);
    expect([...ACCOUNT_FOLDER_SECRETS]).toEqual(['.credentials*', '.claude.json*', 'backups/**']);
    expect(ANYWHERE_SECRETS).toEqual([
      '//**/.credentials*',
      '//**/.claude.json*',
      '//**/.codex/auth.json',
      '//**/opencode/auth.json',
    ]);
    expect([...HOME_SECRETS]).toEqual([
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
      ...DATA.map((entry) => `.dork/${entry}`),
    ]);
    expect(AGENT_FOLDER_SECRETS).toEqual(
      [
        '.env',
        '.env.local',
        '.env.*.local',
        '.env.development',
        '.env.dev',
        '.env.production',
        '.env.prod',
        '.env.staging',
        '.env.test',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        '*.jks',
        '*.keystore',
        '*.tfvars',
        '*.tfstate',
        'id_rsa',
        'id_ed25519',
        'id_ecdsa',
        'id_dsa',
        '.netrc',
        '.npmrc',
        '.pypirc',
        '.envrc',
        '.dev.vars',
        '.git-credentials',
        '.pgpass',
        'application_default_credentials.json',
        'credentials',
        'credentials.json',
        '*service-account*.json',
        '.docker/config.json',
        '.kube/config',
      ].map((name) => `**/${name}`)
    );
  });

  it('builds the protected-write lists it had before', () => {
    expect([...PERSON_ONLY_DATA_FOLDERS]).toEqual([
      'permissions',
      'session-relay',
      'extension-snapshots',
      'cache/extensions',
      'marketplace',
      'plugins',
      'browser-profiles',
      'local-browser/saved-logins',
    ]);
    expect([...PERSON_ONLY_DATA_FILES]).toEqual([
      'config.json*',
      'config-*.json.bak',
      'marketplaces.json*',
      'dork*.db*',
    ]);
    expect(PROJECT_PLUGIN_DENY_RULES).toEqual([
      'Edit(//**/.dork/plugins/**)',
      'Write(//**/.dork/plugins/**)',
      'NotebookEdit(//**/.dork/plugins/**)',
    ]);
  });

  it('builds the agent-home self-grant rules it had before', () => {
    const tools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    const launch = [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/skills/**',
      '.claude/commands/**',
      '.claude/agents/**',
      '.agents/**',
      '.mcp.json',
      '.dork/agent.json',
    ];
    const all = ['.claude/**', '.agents/**', '.mcp.json', '.dork/agent.json'];
    const expected = (files: string[]) =>
      tools.flatMap((tool) => files.map((file) => `${tool}(//x/dork/agents/*/${file})`));
    expect(agentHomesSelfGrantRules('/x/dork', 'launch')).toEqual(expected(launch));
    expect(agentHomesSelfGrantRules('/x/dork', 'all')).toEqual(expected(all));
  });

  it('keeps the home-folder self-grant rules it had before', () => {
    const rules = selfGrantDenyRules({
      home: '/x/home/agent',
      dorkHome: '/x/missing-dork-home',
      accountRoot: '/x/account',
    });
    const home = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].flatMap((tool) => [
      `${tool}(~/.claude/**)`,
      `${tool}(~/.claude.json)`,
      ...[
        'config.json',
        'host.key',
        'mcp-local-token',
        'better-auth-secret',
        'marketplaces.json',
      ].map((name) => `${tool}(~/.dork/${name})`),
    ]);
    expect(rules).toBeDefined();
    for (const rule of home) expect(rules).toContain(rule);
    for (const name of [
      'config.json',
      'host.key',
      'mcp-local-token',
      'better-auth-secret',
      'marketplaces.json',
    ]) {
      expect(rules).toContain(`Edit(//x/missing-dork-home/${name})`);
    }
  });
});
