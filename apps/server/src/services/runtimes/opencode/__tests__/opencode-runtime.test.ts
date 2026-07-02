import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { checkOpenCodeDependencies } from '../check-dependencies.js';

vi.mock('../check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(),
}));

const SATISFIED_CHECKS: DependencyCheck[] = [
  {
    name: 'OpenCode CLI',
    description: 'The OpenCode CLI powers OpenCode agent sessions in DorkOS.',
    status: 'satisfied',
    version: '1.17.13',
  },
  {
    name: 'OpenCode authentication',
    description: 'OpenCode provider credentials.',
    status: 'satisfied',
  },
];

describe('OpenCodeRuntime', () => {
  let runtime: OpenCodeRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new OpenCodeRuntime();
  });

  it('identifies as the opencode runtime', () => {
    expect(runtime.type).toBe('opencode');
  });

  it('delegates checkDependencies to checkOpenCodeDependencies', async () => {
    vi.mocked(checkOpenCodeDependencies).mockReturnValue(SATISFIED_CHECKS);

    const checks = await runtime.checkDependencies();

    expect(checkOpenCodeDependencies).toHaveBeenCalledOnce();
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
