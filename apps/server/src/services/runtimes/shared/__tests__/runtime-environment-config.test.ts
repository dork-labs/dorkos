import { afterEach, describe, expect, it, vi } from 'vitest';

const inherit = vi.hoisted(() => ({
  claudeCode: [] as string[],
  codex: [] as string[],
  opencode: [] as string[],
  doe: [] as string[],
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: () => ({ environment: { inherit } }) },
}));

import { runtimeEnvironment } from '../runtime-environment-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtime of Object.keys(inherit) as Array<keyof typeof inherit>) inherit[runtime] = [];
});

describe('what a turn tells the /flow plugin (DOR-2405)', () => {
  it.each(['claude-code', 'codex', 'opencode', 'doe'] as const)(
    'names the runtime and DorkOS as its host: %s',
    (runtime) => {
      expect(runtimeEnvironment(runtime, 'turn')).toMatchObject({
        FLOW_RUNTIME: runtime,
        FLOW_HARNESS: 'dorkos',
      });
    }
  );

  it.each([
    ['claude-code', 'claudeCode'],
    ['codex', 'codex'],
    ['opencode', 'opencode'],
    ['doe', 'doe'],
  ] as const)(
    'pins %s identity over inherited values and caller overrides',
    (runtime, configKey) => {
      vi.stubEnv('FLOW_RUNTIME', 'person');
      vi.stubEnv('FLOW_HARNESS', 'cmux');
      inherit[configKey] = ['FLOW_RUNTIME', 'FLOW_HARNESS'];
      expect(
        runtimeEnvironment(runtime, 'turn', { FLOW_RUNTIME: 'person', FLOW_HARNESS: 'spoof' })
      ).toMatchObject({ FLOW_RUNTIME: runtime, FLOW_HARNESS: 'dorkos' });
    }
  );

  it('keeps the caller’s own overrides', () => {
    expect(runtimeEnvironment('claude-code', 'turn', { CLAUDE_CONFIG_DIR: '/synthetic' })).toEqual(
      expect.objectContaining({ CLAUDE_CONFIG_DIR: '/synthetic', FLOW_HARNESS: 'dorkos' })
    );
  });

  for (const runtime of ['claude-code', 'codex', 'opencode', 'doe'] as const) {
    it.each([
      'warmup',
      'auth-probe',
      'version-probe',
      'locator',
      'login',
      'provision',
      'process-inspection',
    ] as const)(`stays out of the ${runtime} helper process: %s`, (purpose) => {
      const env = runtimeEnvironment(runtime, purpose);
      expect(env).not.toHaveProperty('FLOW_RUNTIME');
      expect(env).not.toHaveProperty('FLOW_HARNESS');
    });
  }
});
