import { describe, it, expect } from 'vitest';
import { resolveThinkingOptions } from '../messaging/thinking-config.js';

describe('resolveThinkingOptions', () => {
  describe('adaptive-capable models (Opus 4.8/4.7/4.6, Sonnet 4.6)', () => {
    const capability = { supportsAdaptiveThinking: true };

    it('forces summarized adaptive thinking so omitted-default models stream thinking text', () => {
      // Purpose: the core fix — Opus 4.8 must receive display:'summarized' to emit
      // readable thinking_delta events instead of an empty (omitted) thinking block.
      const result = resolveThinkingOptions({ effort: 'high', capability });
      expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(result.effort).toBe('high');
    });

    it('disables thinking when effort is "none"', () => {
      const result = resolveThinkingOptions({ effort: 'none', capability });
      expect(result.thinking).toEqual({ type: 'disabled' });
      expect(result.effort).toBeUndefined();
    });

    it('maps DorkOS "minimal" effort to the SDK\'s "low"', () => {
      const result = resolveThinkingOptions({ effort: 'minimal', capability });
      expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(result.effort).toBe('low');
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
      'passes through the valid SDK effort level "%s"',
      (effort) => {
        const result = resolveThinkingOptions({ effort, capability });
        expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(result.effort).toBe(effort);
      }
    );

    it('omits effort when none is set but still forces summarized thinking', () => {
      const result = resolveThinkingOptions({ effort: undefined, capability });
      expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(result.effort).toBeUndefined();
    });
  });

  describe('non-adaptive models (Haiku, Opus/Sonnet 4.5)', () => {
    const capability = { supportsAdaptiveThinking: false };

    it('never attaches a thinking config (adaptive would 400)', () => {
      // Purpose: guard the regression that motivated capability-gating — sending
      // thinking:{type:'adaptive'} to Haiku errors, and Haiku is what works today.
      const result = resolveThinkingOptions({ effort: 'high', capability });
      expect(result.thinking).toBeUndefined();
      expect(result.effort).toBe('high');
    });

    it('still normalizes effort (minimal -> low)', () => {
      const result = resolveThinkingOptions({ effort: 'minimal', capability });
      expect(result.thinking).toBeUndefined();
      expect(result.effort).toBe('low');
    });

    it('drops "none" effort without a thinking config', () => {
      const result = resolveThinkingOptions({ effort: 'none', capability });
      expect(result.thinking).toBeUndefined();
      expect(result.effort).toBeUndefined();
    });
  });

  describe('unknown capability (cold cache / default model)', () => {
    it('leaves thinking unset when capability is undefined (preserves current behavior)', () => {
      const result = resolveThinkingOptions({ effort: 'high', capability: undefined });
      expect(result.thinking).toBeUndefined();
      expect(result.effort).toBe('high');
    });
  });
});
