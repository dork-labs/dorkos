import { describe, it, expect } from 'vitest';
import {
  AnthropicLogo,
  CodexLogo,
  OpenCodeLogo,
  DefaultAdapterIcon,
} from '@dorkos/icons/adapter-logos';
import { RUNTIME_DESCRIPTORS, getRuntimeDescriptor } from '../config/runtime-descriptors';

describe('RUNTIME_DESCRIPTORS', () => {
  it('registers all four known runtime types', () => {
    expect(Object.keys(RUNTIME_DESCRIPTORS).sort()).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'test-mode',
    ]);
  });

  it('every descriptor carries a matching type, label, icon, and accent', () => {
    for (const [type, descriptor] of Object.entries(RUNTIME_DESCRIPTORS)) {
      expect(descriptor.type).toBe(type);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.icon).toBeDefined();
      expect(descriptor.accent.length).toBeGreaterThan(0);
    }
  });
});

describe('getRuntimeDescriptor', () => {
  it('returns the OpenCode descriptor for "opencode"', () => {
    const descriptor = getRuntimeDescriptor('opencode');
    expect(descriptor.label).toBe('OpenCode');
    expect(descriptor.icon).toBe(OpenCodeLogo);
    expect(descriptor).toBe(RUNTIME_DESCRIPTORS.opencode);
  });

  it('returns the Codex descriptor for "codex"', () => {
    const descriptor = getRuntimeDescriptor('codex');
    expect(descriptor.label).toBe('Codex');
    expect(descriptor.icon).toBe(CodexLogo);
  });

  it('returns the Claude Code descriptor for "claude-code"', () => {
    const descriptor = getRuntimeDescriptor('claude-code');
    expect(descriptor.label).toBe('Claude Code');
    expect(descriptor.icon).toBe(AnthropicLogo);
  });

  it('returns the Test Mode descriptor for "test-mode"', () => {
    expect(getRuntimeDescriptor('test-mode').label).toBe('Test Mode');
  });

  it('returns a neutral fallback for unknown types instead of throwing', () => {
    const descriptor = getRuntimeDescriptor('made-up');
    expect(descriptor.type).toBe('made-up');
    expect(descriptor.label).toBe('made-up');
    expect(descriptor.icon).toBe(DefaultAdapterIcon);
    expect(descriptor.accent.length).toBeGreaterThan(0);
  });
});
