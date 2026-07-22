import { describe, it, expect } from 'vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { classifyTier, parseParamsB, sortModelOptions } from '../model-tiers.js';

/** Build a minimal model option for a sort/classify row. */
function opt(value: string, displayName = value, tier?: ModelOption['tier']): ModelOption {
  return { value, displayName, description: value, ...(tier ? { tier } : {}) };
}

describe('parseParamsB', () => {
  it('reads a parameter count suffixed with b at a token boundary', () => {
    expect(parseParamsB('qwen2.5-coder:7b')).toBe(7);
    expect(parseParamsB('deepseek-r1:14b')).toBe(14);
    expect(parseParamsB('qwen2.5-coder:32b-instruct')).toBe(32);
    expect(parseParamsB('llama3.2:3b')).toBe(3);
    expect(parseParamsB('phi-3.5:3.8b')).toBe(3.8);
    expect(parseParamsB('deepseek-r1:70b')).toBe(70);
    expect(parseParamsB('qwen2.5-coder:0.5b')).toBe(0.5);
  });

  it('never mistakes a version number for a parameter count', () => {
    // The `2.5`, `3.2`, `5` are versions — none is suffixed with `b`.
    expect(parseParamsB('qwen2.5-coder')).toBeUndefined();
    expect(parseParamsB('gpt-5')).toBeUndefined();
    expect(parseParamsB('llama3.2')).toBeUndefined();
    expect(parseParamsB('claude-sonnet-4')).toBeUndefined();
  });
});

describe('classifyTier', () => {
  it('tags curated headliners as frontier', () => {
    expect(classifyTier('anthropic/claude-sonnet-4 Claude Sonnet 4')).toBe('frontier');
    expect(classifyTier('anthropic/claude-opus-4 Claude Opus 4')).toBe('frontier');
    expect(classifyTier('openai/gpt-5 GPT-5')).toBe('frontier');
    expect(classifyTier('openai/o3 o3')).toBe('frontier');
    expect(classifyTier('google/gemini-2.5-pro Gemini 2.5 Pro')).toBe('frontier');
    expect(classifyTier('deepseek/deepseek-r1 DeepSeek R1')).toBe('frontier');
    expect(classifyTier('xai/grok-4 Grok 4')).toBe('frontier');
    expect(classifyTier('alibaba/qwen-max Qwen Max')).toBe('frontier');
  });

  it('tiers unknown models by parameter count at the 10B / 70B boundaries', () => {
    // <10B → quick-helper.
    expect(classifyTier('ollama/qwen2.5-coder:7b')).toBe('quick-helper');
    expect(classifyTier('ollama/tinyllama:1.1b')).toBe('quick-helper');
    // 10B and 70B inclusive → solid-coder.
    expect(classifyTier('ollama/some-coder:10b')).toBe('solid-coder');
    expect(classifyTier('ollama/deepseek-coder-v2:16b')).toBe('solid-coder');
    expect(classifyTier('ollama/big-open:70b')).toBe('solid-coder');
  });

  it('never guesses a headliner: unknown or >70B without a curated match gets no tier', () => {
    expect(classifyTier('ollama/mystery-model:latest')).toBeUndefined();
    expect(classifyTier('some-lab/unknown')).toBeUndefined();
    // A huge open model is not silently promoted to frontier.
    expect(classifyTier('meta/llama:405b')).toBeUndefined();
  });
});

describe('sortModelOptions', () => {
  it('orders Frontier (curated) → Solid coders → Quick helpers → untiered (alphabetical)', () => {
    const input = [
      opt('z/untiered-z', 'Untiered Z'),
      opt('ollama/qwen2.5-coder:7b', 'Qwen Coder 7B', 'quick-helper'),
      opt('a/untiered-a', 'Untiered A'),
      opt('openai/gpt-5', 'GPT-5', 'frontier'),
      opt('ollama/deepseek-coder-v2:16b', 'DeepSeek Coder V2', 'solid-coder'),
      opt('anthropic/claude-opus-4', 'Claude Opus 4', 'frontier'),
    ];

    const sorted = sortModelOptions(input).map((o) => o.displayName);

    expect(sorted).toEqual([
      // Frontier in curated order: Opus pattern precedes GPT-5 pattern.
      'Claude Opus 4',
      'GPT-5',
      // Then solid coders, then quick helpers.
      'DeepSeek Coder V2',
      'Qwen Coder 7B',
      // Then untiered, alphabetical.
      'Untiered A',
      'Untiered Z',
    ]);
  });

  it('is stable within the solid/quick groups (preserves input order) and pure (no mutation)', () => {
    const input = [
      opt('ollama/coder-b:14b', 'Coder B', 'solid-coder'),
      opt('ollama/coder-a:14b', 'Coder A', 'solid-coder'),
      opt('ollama/coder-c:14b', 'Coder C', 'solid-coder'),
    ];
    const before = input.map((o) => o.displayName);

    const sorted = sortModelOptions(input).map((o) => o.displayName);

    // No re-alphabetization within a tier group — input order stands.
    expect(sorted).toEqual(['Coder B', 'Coder A', 'Coder C']);
    // Input array is untouched.
    expect(input.map((o) => o.displayName)).toEqual(before);
  });

  it('treats legacy claude/codex tiers as untiered (sorted after the coarse tiers)', () => {
    const input = [
      opt('anthropic/legacy', 'Legacy Flagship', 'flagship'),
      opt('ollama/quick:1.5b', 'Quick Helper', 'quick-helper'),
    ];
    const sorted = sortModelOptions(input).map((o) => o.displayName);
    expect(sorted).toEqual(['Quick Helper', 'Legacy Flagship']);
  });
});
