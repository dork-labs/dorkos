import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({
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
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>'),
}));
vi.mock('../../../lib/boundary.js', () => ({
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

describe('AgentManager.getSupportedModels', () => {
  let AgentManager: typeof import('../agent-manager.js').AgentManager;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn(),
    }));
    const mod = await import('../agent-manager.js');
    AgentManager = mod.AgentManager;
  });

  it('returns default models when no query has run', async () => {
    const manager = new AgentManager();
    const models = await manager.getSupportedModels();

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      value: 'claude-sonnet-4-5-20250929',
      displayName: 'Sonnet 4.5',
      description: 'Fast, intelligent model for everyday tasks',
    });
    expect(models[1]).toEqual({
      value: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
      description: 'Fastest, most compact model',
    });
    expect(models[2]).toEqual({
      value: 'claude-opus-4-6',
      displayName: 'Opus 4.6',
      description: 'Most capable model for complex tasks',
    });

    // Each model has the required fields
    for (const model of models) {
      expect(model).toHaveProperty('value');
      expect(model).toHaveProperty('displayName');
      expect(model).toHaveProperty('description');
    }
  });

  it('returns cached models after they are populated', async () => {
    const manager = new AgentManager();
    const customModels = [
      { value: 'custom-model', displayName: 'Custom', description: 'A custom model' },
    ];

    // Populate the cache directly via bracket notation
    (manager as Record<string, unknown>)['cachedModels'] = customModels;

    const models = await manager.getSupportedModels();
    expect(models).toEqual(customModels);
    expect(models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'claude-sonnet-4-5-20250929' }),
    ]));
  });
});
