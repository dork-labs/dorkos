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
  inherit.claudeCode = [];
});

describe('what a turn tells the /flow plugin (DOR-2405)', () => {
  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'names the runtime and DorkOS as its host: %s',
    (runtime) => {
      expect(runtimeEnvironment(runtime, 'turn')).toMatchObject({
        FLOW_RUNTIME: runtime,
        FLOW_HARNESS: 'dorkos',
      });
    }
  );

  it('wins over stale values the owner chose to inherit', () => {
    vi.stubEnv('FLOW_RUNTIME', 'codex');
    vi.stubEnv('FLOW_HARNESS', 'cmux');
    inherit.claudeCode = ['FLOW_RUNTIME', 'FLOW_HARNESS'];
    expect(runtimeEnvironment('claude-code', 'turn')).toMatchObject({
      FLOW_RUNTIME: 'claude-code',
      FLOW_HARNESS: 'dorkos',
    });
  });

  it('keeps the caller’s own overrides', () => {
    expect(runtimeEnvironment('claude-code', 'turn', { CLAUDE_CONFIG_DIR: '/synthetic' })).toEqual(
      expect.objectContaining({ CLAUDE_CONFIG_DIR: '/synthetic', FLOW_HARNESS: 'dorkos' })
    );
  });

  it.each([
    'warmup',
    'auth-probe',
    'version-probe',
    'locator',
    'login',
    'provision',
    'process-inspection',
  ] as const)('stays out of the helper process: %s', (purpose) => {
    const env = runtimeEnvironment('claude-code', purpose);
    expect(env).not.toHaveProperty('FLOW_RUNTIME');
    expect(env).not.toHaveProperty('FLOW_HARNESS');
  });

  it('says nothing for the DorkOS builder, which is not a runtime flow knows', () => {
    const env = runtimeEnvironment('doe', 'turn');
    expect(env).not.toHaveProperty('FLOW_RUNTIME');
    expect(env).not.toHaveProperty('FLOW_HARNESS');
  });
});
