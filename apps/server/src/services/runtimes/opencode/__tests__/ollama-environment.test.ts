import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { detectOllamaInstallMethod, provisionOllama } from '../providers/ollama-provision.js';
import { detectHardwareAsync } from '../providers/ollama-catalog.js';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: () => ({ environment: { inherit: { opencode: ['SYNTHETIC_INSTALL_SETTING'] } } }),
  },
}));
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: async (command: string, args: string[], options: unknown) => {
      execFile(command, args, options);
      return { stdout: '2048', stderr: '' };
    },
  });
  return { execFile };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('projects all three production Ollama execFile defaults without model credentials', async () => {
  for (const key of [
    'NANGO_ENCRYPTION_KEY',
    'MCP_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
  ])
    vi.stubEnv(key, 'synthetic-secret');
  vi.stubEnv('DO_NOT_TRACK', '1');
  vi.stubEnv('SYNTHETIC_INSTALL_SETTING', 'synthetic-opt-in');
  expect(await detectOllamaInstallMethod({ platform: 'win32' })).toBe('winget');
  const detectOllamaFn = vi.fn(async () => ({ running: true, models: [] }));
  expect(
    (
      await provisionOllama(undefined, {
        platform: 'darwin',
        detectOllamaFn,
        resetDetectionCache: vi.fn(),
      })
    ).ok
  ).toBe(true);
  const hardware = await detectHardwareAsync({ unifiedMemory: false });
  expect(hardware.vramBytes).toBe(2048 * 1024 * 1024);
  const calls = vi.mocked(execFile).mock.calls as unknown as [
    string,
    string[],
    { env: Record<string, string> },
  ][];
  expect(calls.map(([command]) => command)).toEqual([
    'where',
    'which',
    'brew',
    'brew',
    'nvidia-smi',
  ]);
  expect(calls[2][1]).toEqual(['install', 'ollama']);
  expect(calls[3][1]).toEqual(['services', 'start', 'ollama']);
  for (const [, , { env }] of calls) {
    expect(env).toMatchObject({ DO_NOT_TRACK: '1', SYNTHETIC_INSTALL_SETTING: 'synthetic-opt-in' });
    for (const key of [
      'NANGO_ENCRYPTION_KEY',
      'MCP_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ])
      expect(env).not.toHaveProperty(key);
  }
});
