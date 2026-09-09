import { describe, expect, it } from 'vitest';
import { projectRuntimeEnvironment } from '../runtime-environment.js';
import { BASELINE_ENV_NAMES, RUNTIME_ENV_PROFILES } from '../runtime-environment-catalog.js';
import {
  RuntimeInheritedEnvNamesSchema,
  RUNTIME_RESERVED_ENV_NAMES,
} from '@dorkos/shared/config-schema';

const parent = {
  PATH: '/synthetic/bin',
  HOME: '/synthetic/home',
  DO_NOT_TRACK: '1',
  NANGO_ENCRYPTION_KEY: 'fake-nango-secret',
  MCP_API_KEY: 'fake-server-token',
  DORKOS_AGENT_TOKEN: 'fake-stale-identity',
  ANTHROPIC_API_KEY: 'fake-anthropic',
  OPENAI_API_KEY: 'fake-openai',
  OPENROUTER_API_KEY: 'fake-openrouter',
  AWS_SECRET_ACCESS_KEY: 'fake-aws',
  GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc',
  AZURE_CLIENT_SECRET: 'fake-azure',
  SYNTHETIC_TOOL_SETTING: 'allowed-on-purpose',
};

describe('runtime environment authority', () => {
  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'preserves OS/privacy without inheriting ambient server authority: %s',
    (runtime) => {
      const before = { ...parent };
      const result = projectRuntimeEnvironment({ parent, runtime, purpose: 'turn' });
      expect(result).toMatchObject({ PATH: parent.PATH, HOME: parent.HOME, DO_NOT_TRACK: '1' });
      for (const key of [
        'NANGO_ENCRYPTION_KEY',
        'MCP_API_KEY',
        'DORKOS_AGENT_TOKEN',
        'SYNTHETIC_TOOL_SETTING',
        'AWS_SECRET_ACCESS_KEY',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'AZURE_CLIENT_SECRET',
      ])
        expect(result).not.toHaveProperty(key);
      expect(parent).toEqual(before);
    }
  );
  it.each(['version-probe', 'locator', 'provision', 'process-inspection'] as const)(
    'withholds automatic model credentials from %s',
    (purpose) => {
      for (const runtime of ['claude-code', 'codex', 'opencode'] as const) {
        expect(projectRuntimeEnvironment({ parent, runtime, purpose })).toEqual({
          PATH: parent.PATH,
          HOME: parent.HOME,
          DO_NOT_TRACK: '1',
        });
      }
    }
  );
  it('allows exact owner custom names, never reserved names or case collisions', () => {
    expect(
      projectRuntimeEnvironment({
        parent,
        runtime: 'codex',
        purpose: 'turn',
        inherit: ['SYNTHETIC_TOOL_SETTING'],
      }).SYNTHETIC_TOOL_SETTING
    ).toBe(parent.SYNTHETIC_TOOL_SETTING);
    for (const name of [...RUNTIME_RESERVED_ENV_NAMES, 'DORKOS_MCP_HDR_INJECTED', 'mcp_api_key'])
      expect(RuntimeInheritedEnvNamesSchema.safeParse([name]).success).toBe(false);
    for (const names of [['NAME', 'name'], ['*'], [''], ['X'.repeat(129)], Array(129).fill('X')])
      expect(RuntimeInheritedEnvNamesSchema.safeParse(names).success).toBe(false);
  });
  it('preserves each approved OS/CLI name and omits unset values', () => {
    const os = Object.fromEntries(BASELINE_ENV_NAMES.map((name) => [name, `synthetic-${name}`]));
    expect(
      projectRuntimeEnvironment({
        parent: { ...os, UNSET: undefined },
        runtime: 'codex',
        purpose: 'locator',
        platform: 'linux',
      })
    ).toEqual(os);
  });
  it.each([
    ['CLAUDE_CODE_USE_BEDROCK', 'Claude Bedrock', 'AWS chain'],
    ['CLAUDE_CODE_USE_VERTEX', 'Claude Vertex', null],
    ['CLAUDE_CODE_USE_FOUNDRY', 'Claude Foundry', null],
  ] as const)(
    'retains every documented alternative only when %s is enabled',
    (selector, profile, chain) => {
      const names = [
        ...RUNTIME_ENV_PROFILES[profile],
        ...(chain ? RUNTIME_ENV_PROFILES[chain] : []),
      ];
      const values = Object.fromEntries(names.map((name) => [name, 'synthetic']));
      for (const flag of ['1', 'TRUE', ' yes ', 'on']) {
        const p = { ...values, [selector]: flag };
        expect(
          projectRuntimeEnvironment({ parent: p, runtime: 'claude-code', purpose: 'turn' })
        ).toEqual(p);
      }
      for (const flag of ['0', 'false', '', undefined])
        expect(
          projectRuntimeEnvironment({
            parent: { ...values, [selector]: flag },
            runtime: 'claude-code',
            purpose: 'turn',
          })
        ).toEqual({});
    }
  );
  it('fails known custom modes instead of falling back to another backend', () => {
    const p = { CLAUDE_CODE_USE_GATEWAY: '1', GATEWAY_KEY: 'synthetic' };
    expect(() =>
      projectRuntimeEnvironment({ parent: p, runtime: 'claude-code', purpose: 'turn' })
    ).toThrow('CLAUDE_CODE_USE_GATEWAY');
    expect(
      projectRuntimeEnvironment({
        parent: p,
        runtime: 'claude-code',
        purpose: 'turn',
        inherit: Object.keys(p),
      })
    ).toEqual(p);
  });
  it('permits only the selected runtime fixed overrides, with account-root deletion', () => {
    expect(
      projectRuntimeEnvironment({
        parent: { CLAUDE_CONFIG_DIR: '/wrong' },
        runtime: 'claude-code',
        purpose: 'turn',
        overrides: { CLAUDE_CONFIG_DIR: undefined, DORKOS_AGENT_TOKEN: 'fresh' },
      })
    ).toEqual({ DORKOS_AGENT_TOKEN: 'fresh' });
    expect(() =>
      projectRuntimeEnvironment({
        parent,
        runtime: 'codex',
        purpose: 'turn',
        overrides: { MCP_API_KEY: 'stolen' },
      })
    ).toThrow('Unsupported');
    expect(() =>
      projectRuntimeEnvironment({
        parent,
        runtime: 'codex',
        purpose: 'locator',
        overrides: { OPENAI_API_KEY: 'wrong-purpose' },
      })
    ).toThrow('Unsupported');
  });
  it('emits one Windows path spelling and denies case-varied secrets', () => {
    const result = projectRuntimeEnvironment({
      parent: { PATH: 'first', Path: 'second', mcp_api_key: 'secret', SystemRoot: 'system' },
      runtime: 'codex',
      purpose: 'turn',
      platform: 'win32',
    });
    expect(result).toEqual({ PATH: 'first', SystemRoot: 'system' });
  });
});

it('preserves enabled cloud profile precedence and Windows case-insensitive selectors', () => {
  const projected = projectRuntimeEnvironment({
    parent: {
      claude_code_use_bedrock: 'TRUE',
      CLAUDE_CODE_USE_VERTEX: '1',
      aws_secret_access_key: 'synthetic-aws',
      GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc',
      AZURE_CLIENT_SECRET: 'synthetic-unused',
      MCP_API_KEY: 'synthetic-server',
    },
    runtime: 'claude-code',
    purpose: 'auth-probe',
    platform: 'win32',
  });
  expect(projected).toEqual({
    claude_code_use_bedrock: 'TRUE',
    CLAUDE_CODE_USE_VERTEX: '1',
    aws_secret_access_key: 'synthetic-aws',
    GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc',
  });
});

it('applies selected credentials last without changing the parent or permitting cross-runtime authority', () => {
  const ambient = { ANTHROPIC_API_KEY: 'synthetic-ambient', OPENAI_API_KEY: 'synthetic-other' };
  expect(
    projectRuntimeEnvironment({
      parent: ambient,
      runtime: 'claude-code',
      purpose: 'turn',
      overrides: { ANTHROPIC_API_KEY: 'synthetic-selected' },
    })
  ).toEqual({ ANTHROPIC_API_KEY: 'synthetic-selected' });
  expect(ambient.ANTHROPIC_API_KEY).toBe('synthetic-ambient');
  expect(() =>
    projectRuntimeEnvironment({
      parent: ambient,
      runtime: 'claude-code',
      purpose: 'turn',
      overrides: { OPENAI_API_KEY: 'synthetic-other' },
    })
  ).toThrow('Unsupported');
});
