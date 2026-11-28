import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inherit = vi.hoisted(() => ({
  claudeCode: [] as string[],
  codex: [] as string[],
  opencode: [] as string[],
  doe: [] as string[],
}));

const pathConfig = vi.hoisted(() => ({ pathPrepend: undefined as string[] | undefined }));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: () => ({ environment: { inherit, pathPrepend: pathConfig.pathPrepend } }),
  },
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimeEnvironment } from '../runtime-environment-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtime of Object.keys(inherit) as Array<keyof typeof inherit>) inherit[runtime] = [];
  pathConfig.pathPrepend = undefined;
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

describe('runtimes.environment.pathPrepend', () => {
  const runtimes = ['claude-code', 'codex', 'opencode', 'doe'] as const;
  let root: string;
  let shims: string;
  let tools: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'path-prepend-'));
    shims = path.join(root, 'shims');
    tools = path.join(root, 'tools');
    mkdirSync(shims);
    mkdirSync(tools);
    vi.stubEnv('PATH', '/usr/bin:/bin');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(runtimes)('puts the directories first, in order, in a %s turn', (runtime) => {
    pathConfig.pathPrepend = [shims, tools];
    expect(runtimeEnvironment(runtime, 'turn').PATH).toBe(`${shims}:${tools}:/usr/bin:/bin`);
  });

  it.each(runtimes)('leaves a %s turn PATH alone when the setting is unset', (runtime) => {
    expect(runtimeEnvironment(runtime, 'turn').PATH).toBe('/usr/bin:/bin');
    pathConfig.pathPrepend = [];
    expect(runtimeEnvironment(runtime, 'turn').PATH).toBe('/usr/bin:/bin');
  });

  it.each(runtimes)('leaves out a directory that is missing or a file (%s)', (runtime) => {
    const file = path.join(root, 'file');
    writeFileSync(file, '');
    pathConfig.pathPrepend = [path.join(root, 'gone'), file, shims];
    expect(runtimeEnvironment(runtime, 'turn').PATH).toBe(`${shims}:/usr/bin:/bin`);
  });

  it('keeps one copy of a directory that is already on PATH', () => {
    vi.stubEnv('PATH', `/usr/bin:${shims}:/bin`);
    pathConfig.pathPrepend = [shims, shims];
    expect(runtimeEnvironment('codex', 'turn').PATH).toBe(`${shims}:/usr/bin:/bin`);
  });

  for (const runtime of runtimes) {
    it.each([
      'warmup',
      'auth-probe',
      'version-probe',
      'locator',
      'login',
      'provision',
      'process-inspection',
    ] as const)(`stays out of the ${runtime} helper process: %s`, (purpose) => {
      pathConfig.pathPrepend = [shims];
      expect(runtimeEnvironment(runtime, purpose).PATH).toBe('/usr/bin:/bin');
    });
  }
});
