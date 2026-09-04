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

  it('gives every runtime a person chooses between a one-line identity', () => {
    expect(RUNTIME_DESCRIPTORS['claude-code']?.subtitle).toBe(
      'Anthropic · frontier models in the cloud'
    );
    expect(RUNTIME_DESCRIPTORS.codex?.subtitle).toBe('OpenAI · GPT models');
    expect(RUNTIME_DESCRIPTORS.opencode?.subtitle).toBe('Your own models, local or any service');
  });

  it('leaves the subtitle off a runtime that is not one of those choices', () => {
    // test-mode is an e2e artifact, not a product runtime: there is nothing
    // honest to say about who makes it or what it runs on.
    expect(RUNTIME_DESCRIPTORS['test-mode']?.subtitle).toBeUndefined();
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
    // No invented identity line for a runtime nobody here knows anything about.
    expect(descriptor.subtitle).toBeUndefined();
  });

  // A runtime type is a free string that arrives from stored data — a task's
  // `runtime` (any non-empty string on the wire), an agent manifest — so these
  // five are reachable values, not theatre. A plain `RUNTIME_DESCRIPTORS[type]`
  // answers every one of them with a member inherited from `Object.prototype`,
  // which is truthy, so the `??` fallback never fires and the caller is handed a
  // "descriptor" with no `label`: a blank select option, and the sentence
  // "undefined is not connected on this machine" (DOR-1615).
  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    'falls back for "%s" rather than answering with an inherited member',
    (type) => {
      const descriptor = getRuntimeDescriptor(type);
      expect(descriptor.type).toBe(type);
      expect(descriptor.label).toBe(type);
      expect(descriptor.icon).toBe(DefaultAdapterIcon);
      expect(descriptor.subtitle).toBeUndefined();
    }
  );

  it('hands back the registry object itself for a declared runtime', () => {
    // The other half of the same guard: keeping prototype keys out must not cost
    // identity. A lookup that rebuilt or copied the descriptor would still read
    // correctly field by field, and would quietly break the `toBe` the OpenCode
    // case above depends on.
    expect(getRuntimeDescriptor('claude-code')).toBe(RUNTIME_DESCRIPTORS['claude-code']);
    expect(getRuntimeDescriptor('codex')).toBe(RUNTIME_DESCRIPTORS.codex);
  });
});
