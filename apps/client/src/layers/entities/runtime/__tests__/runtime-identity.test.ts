import { describe, it, expect } from 'vitest';
import { formatModelLabel, formatRuntimeIdentity } from '../lib/runtime-identity';

describe('formatModelLabel', () => {
  it('strips the provider prefix from an OpenCode-style id', () => {
    expect(formatModelLabel('ollama/qwen2.5-coder')).toBe('qwen2.5-coder');
  });

  it('passes a bare model id through unchanged', () => {
    expect(formatModelLabel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('takes only the final segment for nested provider ids', () => {
    expect(formatModelLabel('openrouter/anthropic/claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
  });

  it('returns null for an absent, blank, or prefix-only model', () => {
    expect(formatModelLabel(null)).toBeNull();
    expect(formatModelLabel(undefined)).toBeNull();
    expect(formatModelLabel('   ')).toBeNull();
    expect(formatModelLabel('ollama/')).toBeNull();
  });
});

describe('formatRuntimeIdentity', () => {
  it('formats runtime + model with the descriptor label', () => {
    expect(formatRuntimeIdentity({ runtime: 'opencode', model: 'ollama/qwen2.5-coder' })).toEqual({
      label: 'OpenCode',
      modelLabel: 'qwen2.5-coder',
      text: 'OpenCode · qwen2.5-coder',
    });
  });

  it('degrades to the runtime alone when no model is resolved', () => {
    const identity = formatRuntimeIdentity({ runtime: 'claude-code', model: null });
    expect(identity.modelLabel).toBeNull();
    expect(identity.text).toBe('Claude Code');
  });

  it('uses the neutral fallback label for an unknown runtime', () => {
    expect(formatRuntimeIdentity({ runtime: 'made-up' }).text).toBe('made-up');
  });
});
