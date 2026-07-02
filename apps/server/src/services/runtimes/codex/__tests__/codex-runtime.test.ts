import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { CodexRuntime } from '../codex-runtime.js';
import { checkCodexDependencies } from '../check-dependencies.js';

vi.mock('../check-dependencies.js', () => ({
  checkCodexDependencies: vi.fn(),
}));

const SATISFIED_CHECKS: DependencyCheck[] = [
  {
    name: 'Codex CLI',
    description: 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.',
    status: 'satisfied',
    version: 'codex-cli 0.142.5',
  },
  {
    name: 'Codex authentication',
    description: 'Codex login state.',
    status: 'satisfied',
  },
];

describe('CodexRuntime', () => {
  let runtime: CodexRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new CodexRuntime();
  });

  it('identifies as the codex runtime', () => {
    expect(runtime.type).toBe('codex');
  });

  it('delegates checkDependencies to checkCodexDependencies', async () => {
    vi.mocked(checkCodexDependencies).mockReturnValue(SATISFIED_CHECKS);

    const checks = await runtime.checkDependencies();

    expect(checkCodexDependencies).toHaveBeenCalledOnce();
    expect(checks).toEqual(SATISFIED_CHECKS);
  });

  it('throws not-implemented for methods later tasks fill in', () => {
    expect(() => runtime.ensureSession('s1', { permissionMode: 'default' })).toThrow(
      /not implemented/i
    );
    expect(() => runtime.sendMessage('s1', 'hello')).toThrow(/not implemented/i);
    expect(() => runtime.listSessions('/tmp/p')).toThrow(/not implemented/i);
    expect(() => runtime.getCapabilities()).toThrow(/not implemented/i);
    expect(() => runtime.interruptQuery('s1')).toThrow(/not implemented/i);
  });
});
