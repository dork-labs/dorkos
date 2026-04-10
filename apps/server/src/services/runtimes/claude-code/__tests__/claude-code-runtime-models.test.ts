import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));
// Mock the canonical path so that ClaudeCodeRuntime's direct import is intercepted.
const { contextBuilderFactory } = vi.hoisted(() => ({
  contextBuilderFactory: () => ({
    buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>'),
    buildPerMessageContext: vi.fn().mockResolvedValue(''),
  }),
}));
vi.mock('../context-builder.js', contextBuilderFactory);
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

describe('ClaudeCodeRuntime.getSupportedModels', () => {
  let ClaudeCodeRuntime: typeof import('../claude-code-runtime.js').ClaudeCodeRuntime;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn(),
    }));
    const mod = await import('../claude-code-runtime.js');
    ClaudeCodeRuntime = mod.ClaudeCodeRuntime;
  });

  it('returns empty array when no cache or warm-up is available', async () => {
    const manager = new ClaudeCodeRuntime('/tmp/dorkos-test');
    const models = await manager.getSupportedModels();

    // No disk cache, no warm-up in test — returns empty array
    expect(models).toEqual([]);
  });

  it('returns cached models after they are populated', async () => {
    const manager = new ClaudeCodeRuntime('/tmp/dorkos-test');
    const customModels = [
      { value: 'custom-model', displayName: 'Custom', description: 'A custom model' },
    ];

    // Populate the cache directly via bracket notation (cachedModels lives on the RuntimeCache collaborator)
    const cache = (manager as Record<string, unknown>)['cache'] as Record<string, unknown>;
    cache['cachedModels'] = customModels;

    const models = await manager.getSupportedModels();
    expect(models).toEqual(customModels);
  });
});
