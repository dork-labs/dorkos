import { describe, it, expect } from 'vitest';
import { deriveModelNature, parseParamsB } from '../lib/model-nature';

describe('parseParamsB', () => {
  it('reads a trailing size token in billions', () => {
    expect(parseParamsB('qwen2.5-coder:7b')).toBe(7);
    expect(parseParamsB('llama3.1:70b')).toBe(70);
    expect(parseParamsB('ollama/qwen2.5-coder:32b')).toBe(32);
  });

  it('returns null when the id carries no size', () => {
    expect(parseParamsB('qwen2.5-coder')).toBeNull();
    expect(parseParamsB('anthropic/claude-3.5-sonnet')).toBeNull();
  });
});

describe('deriveModelNature — locality is derived, not hardcoded', () => {
  it('marks an Ollama model as local · private · free', () => {
    const nature = deriveModelNature({ provider: 'ollama', modelId: 'qwen2.5-coder:7b' });
    expect(nature.locality).toBe('local');
    expect(nature.badgeLabel).toBe('local · private · free');
    expect(nature.benefit).toMatch(/private and free/i);
  });

  it('derives local from a provider-prefixed id when no provider is given', () => {
    expect(deriveModelNature({ modelId: 'ollama/qwen2.5-coder:7b' }).locality).toBe('local');
  });

  it('marks a cloud gateway model as cloud · per-token', () => {
    const nature = deriveModelNature({
      provider: 'openrouter',
      modelId: 'anthropic/claude-3.5-sonnet',
    });
    expect(nature.locality).toBe('cloud');
    expect(nature.badgeLabel).toBe('cloud · per-token');
  });

  it('defaults an unknown provider to cloud — never falsely "free"', () => {
    expect(deriveModelNature({ modelId: 'some-mystery-model' }).locality).toBe('cloud');
  });

  it('never sells a small local model as frontier-equivalent (honest sub-14B caveat)', () => {
    const nature = deriveModelNature({ provider: 'ollama', modelId: 'qwen2.5-coder:7b' });
    expect(nature.capability).toMatch(/not frontier/i);
    expect(nature.capability).toMatch(/14b/i);
  });

  it('stays honest for a capable local model without claiming frontier', () => {
    const nature = deriveModelNature({ provider: 'ollama', modelId: 'qwen2.5-coder:32b' });
    expect(nature.locality).toBe('local');
    expect(nature.capability).toMatch(/frontier quality still comes from/i);
  });
});
