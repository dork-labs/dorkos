import { describe, it, expect } from 'vitest';
import {
  TraitsSchema,
  ConventionsSchema,
  AgentManifestSchema,
  UpdateAgentRequestSchema,
  UpdateAgentConventionsSchema,
} from '../mesh-schemas.js';

// Minimal valid manifest fixture
const baseManifest = {
  id: 'agent-001',
  name: 'test-agent',
  runtime: 'claude-code' as const,
  registeredAt: new Date().toISOString(),
  registeredBy: 'system',
};

describe('TraitsSchema — defaults', () => {
  it('defaults all traits to 3 when parsed with empty object', () => {
    const result = TraitsSchema.parse({});
    expect(result).toEqual({
      verbosity: 3,
      autonomy: 3,
      chaos: 3,
      creativity: 3,
      humor: 3,
      spice: 3,
    });
  });

  it('preserves explicitly provided trait values', () => {
    const result = TraitsSchema.parse({ verbosity: 1, autonomy: 5, chaos: 2 });
    expect(result.verbosity).toBe(1);
    expect(result.autonomy).toBe(5);
    expect(result.chaos).toBe(2);
    // unset fields still default to 3
    expect(result.creativity).toBe(3);
    expect(result.humor).toBe(3);
    expect(result.spice).toBe(3);
  });
});

describe('TraitsSchema — valid range (1-5)', () => {
  it('accepts minimum value 1 for all traits', () => {
    const result = TraitsSchema.parse({
      verbosity: 1,
      autonomy: 1,
      chaos: 1,
      creativity: 1,
      humor: 1,
      spice: 1,
    });
    expect(result).toEqual({
      verbosity: 1,
      autonomy: 1,
      chaos: 1,
      creativity: 1,
      humor: 1,
      spice: 1,
    });
  });

  it('accepts maximum value 5 for all traits', () => {
    const result = TraitsSchema.parse({
      verbosity: 5,
      autonomy: 5,
      chaos: 5,
      creativity: 5,
      humor: 5,
      spice: 5,
    });
    expect(result).toEqual({
      verbosity: 5,
      autonomy: 5,
      chaos: 5,
      creativity: 5,
      humor: 5,
      spice: 5,
    });
  });

  it('accepts mid-range values', () => {
    const result = TraitsSchema.parse({ verbosity: 2, autonomy: 3, chaos: 4 });
    expect(result.verbosity).toBe(2);
    expect(result.autonomy).toBe(3);
    expect(result.chaos).toBe(4);
  });
});

describe('TraitsSchema — invalid range', () => {
  it('rejects verbosity value of 0 (below minimum)', () => {
    expect(() => TraitsSchema.parse({ verbosity: 0 })).toThrow();
  });

  it('rejects verbosity value of 6 (above maximum)', () => {
    expect(() => TraitsSchema.parse({ verbosity: 6 })).toThrow();
  });

  it('rejects autonomy value of -1', () => {
    expect(() => TraitsSchema.parse({ autonomy: -1 })).toThrow();
  });

  it('rejects chaos value of 10', () => {
    expect(() => TraitsSchema.parse({ chaos: 10 })).toThrow();
  });

  it('rejects non-integer float values', () => {
    expect(() => TraitsSchema.parse({ verbosity: 2.5 })).toThrow();
  });

  it('rejects string trait values', () => {
    expect(() => TraitsSchema.parse({ verbosity: 'high' })).toThrow();
  });
});

describe('ConventionsSchema — defaults', () => {
  it('defaults soul, nope, and dorkosKnowledge to true when parsed with empty object', () => {
    const result = ConventionsSchema.parse({});
    expect(result).toEqual({ soul: true, nope: true, dorkosKnowledge: true });
  });

  it('accepts explicit false for soul', () => {
    const result = ConventionsSchema.parse({ soul: false });
    expect(result.soul).toBe(false);
    expect(result.nope).toBe(true);
    expect(result.dorkosKnowledge).toBe(true);
  });

  it('accepts explicit false for nope', () => {
    const result = ConventionsSchema.parse({ nope: false });
    expect(result.soul).toBe(true);
    expect(result.nope).toBe(false);
    expect(result.dorkosKnowledge).toBe(true);
  });

  it('accepts explicit false for dorkosKnowledge', () => {
    const result = ConventionsSchema.parse({ dorkosKnowledge: false });
    expect(result.soul).toBe(true);
    expect(result.nope).toBe(true);
    expect(result.dorkosKnowledge).toBe(false);
  });

  it('accepts all set to false', () => {
    const result = ConventionsSchema.parse({ soul: false, nope: false, dorkosKnowledge: false });
    expect(result).toEqual({ soul: false, nope: false, dorkosKnowledge: false });
  });

  it('accepts all set to true explicitly', () => {
    const result = ConventionsSchema.parse({ soul: true, nope: true, dorkosKnowledge: true });
    expect(result).toEqual({ soul: true, nope: true, dorkosKnowledge: true });
  });

  it('rejects non-boolean values', () => {
    expect(() => ConventionsSchema.parse({ soul: 'yes' })).toThrow();
  });
});

describe('AgentManifestSchema — traits field', () => {
  it('allows traits to be omitted (optional)', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.traits).toBeUndefined();
  });

  it('accepts a valid traits object', () => {
    const result = AgentManifestSchema.parse({
      ...baseManifest,
      traits: { verbosity: 4, autonomy: 2, chaos: 5, creativity: 3, humor: 1, spice: 3 },
    });
    expect(result.traits).toEqual({
      verbosity: 4,
      autonomy: 2,
      chaos: 5,
      creativity: 3,
      humor: 1,
      spice: 3,
    });
  });

  it('applies TraitsSchema defaults when traits is provided as empty object', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, traits: {} });
    expect(result.traits).toEqual({
      verbosity: 3,
      autonomy: 3,
      chaos: 3,
      creativity: 3,
      humor: 3,
      spice: 3,
    });
  });

  it('rejects out-of-range trait values inside a manifest', () => {
    expect(() =>
      AgentManifestSchema.parse({ ...baseManifest, traits: { verbosity: 0 } })
    ).toThrow();
  });
});

describe('AgentManifestSchema — conventions field', () => {
  it('allows conventions to be omitted (optional)', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.conventions).toBeUndefined();
  });

  it('accepts a valid conventions object', () => {
    const result = AgentManifestSchema.parse({
      ...baseManifest,
      conventions: { soul: true, nope: false },
    });
    expect(result.conventions).toEqual({ soul: true, nope: false, dorkosKnowledge: true });
  });

  it('applies ConventionsSchema defaults when conventions is provided as empty object', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, conventions: {} });
    expect(result.conventions).toEqual({ soul: true, nope: true, dorkosKnowledge: true });
  });
});

describe('AgentManifestSchema — existing manifests without personality fields still parse', () => {
  it('parses a minimal manifest without traits or conventions', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.id).toBe('agent-001');
    expect(result.traits).toBeUndefined();
    expect(result.conventions).toBeUndefined();
  });

  it('parses a full manifest without personality fields', () => {
    const result = AgentManifestSchema.parse({
      ...baseManifest,
      description: 'A test agent',
      capabilities: ['read'],
      persona: 'You are a test agent.',
      personaEnabled: true,
      color: '#ff0000',
      icon: '🤖',
    });
    expect(result.traits).toBeUndefined();
    expect(result.conventions).toBeUndefined();
    expect(result.persona).toBe('You are a test agent.');
  });
});

describe('UpdateAgentRequestSchema — traits and conventions', () => {
  it('accepts traits in a partial update', () => {
    const result = UpdateAgentRequestSchema.parse({ traits: { verbosity: 5 } });
    expect(result.traits?.verbosity).toBe(5);
  });

  it('accepts conventions in a partial update', () => {
    const result = UpdateAgentRequestSchema.parse({ conventions: { soul: false } });
    expect(result.conventions?.soul).toBe(false);
    expect(result.conventions?.nope).toBe(true);
  });

  it('accepts traits and conventions together', () => {
    const result = UpdateAgentRequestSchema.parse({
      traits: { autonomy: 4 },
      conventions: { nope: false },
    });
    expect(result.traits?.autonomy).toBe(4);
    expect(result.conventions?.nope).toBe(false);
  });

  it('rejects out-of-range trait in update', () => {
    expect(() => UpdateAgentRequestSchema.parse({ traits: { verbosity: 6 } })).toThrow();
  });
});

describe('UpdateAgentConventionsSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = UpdateAgentConventionsSchema.parse({});
    expect(result.soulContent).toBeUndefined();
    expect(result.nopeContent).toBeUndefined();
    expect(result.traits).toBeUndefined();
    expect(result.conventions).toBeUndefined();
  });

  it('accepts valid soulContent within 4000 chars', () => {
    const result = UpdateAgentConventionsSchema.parse({ soulContent: 'You are helpful.' });
    expect(result.soulContent).toBe('You are helpful.');
  });

  it('accepts soulContent of exactly 4000 chars', () => {
    const result = UpdateAgentConventionsSchema.parse({ soulContent: 'a'.repeat(4000) });
    expect(result.soulContent).toHaveLength(4000);
  });

  it('rejects soulContent exceeding 4000 chars', () => {
    expect(() => UpdateAgentConventionsSchema.parse({ soulContent: 'a'.repeat(4001) })).toThrow();
  });

  it('accepts valid nopeContent within 2000 chars', () => {
    const result = UpdateAgentConventionsSchema.parse({ nopeContent: 'Never do X.' });
    expect(result.nopeContent).toBe('Never do X.');
  });

  it('accepts nopeContent of exactly 2000 chars', () => {
    const result = UpdateAgentConventionsSchema.parse({ nopeContent: 'b'.repeat(2000) });
    expect(result.nopeContent).toHaveLength(2000);
  });

  it('rejects nopeContent exceeding 2000 chars', () => {
    expect(() => UpdateAgentConventionsSchema.parse({ nopeContent: 'b'.repeat(2001) })).toThrow();
  });

  it('accepts traits with valid values', () => {
    const result = UpdateAgentConventionsSchema.parse({ traits: { chaos: 1 } });
    expect(result.traits?.chaos).toBe(1);
    expect(result.traits?.verbosity).toBe(3); // default
  });

  it('rejects traits with out-of-range values', () => {
    expect(() => UpdateAgentConventionsSchema.parse({ traits: { creativity: 0 } })).toThrow();
  });

  it('accepts conventions toggles', () => {
    const result = UpdateAgentConventionsSchema.parse({
      conventions: { soul: false, nope: true },
    });
    expect(result.conventions?.soul).toBe(false);
    expect(result.conventions?.nope).toBe(true);
    expect(result.conventions?.dorkosKnowledge).toBe(true);
  });

  it('accepts all fields together', () => {
    const result = UpdateAgentConventionsSchema.parse({
      soulContent: 'You are a specialist.',
      nopeContent: 'Never skip tests.',
      traits: { verbosity: 2, autonomy: 4 },
      conventions: { soul: true, nope: false },
    });
    expect(result.soulContent).toBe('You are a specialist.');
    expect(result.nopeContent).toBe('Never skip tests.');
    expect(result.traits?.verbosity).toBe(2);
    expect(result.traits?.autonomy).toBe(4);
    expect(result.conventions?.soul).toBe(true);
    expect(result.conventions?.nope).toBe(false);
    expect(result.conventions?.dorkosKnowledge).toBe(true);
  });
});
