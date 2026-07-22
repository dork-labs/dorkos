import { describe, it, expect } from 'vitest';
import { describePowerSource } from '../lib/power-source';

describe('describePowerSource', () => {
  it('names the local and cloud sources in plain language', () => {
    expect(describePowerSource('ollama')).toBe('On your computer (Ollama)');
    expect(describePowerSource('openrouter')).toBe('Cloud via OpenRouter');
  });

  it('names known bring-your-own-key providers', () => {
    expect(describePowerSource('openai')).toBe('Your own API key (OpenAI)');
    expect(describePowerSource('anthropic')).toBe('Your own API key (Anthropic)');
  });

  it('falls back to the raw provider id for an unknown own-key source', () => {
    expect(describePowerSource('my-vllm')).toBe('Your own API key (my-vllm)');
  });
});
