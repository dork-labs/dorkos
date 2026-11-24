import { describe, it, expect } from 'vitest';
import { MEMORY_MAX_CHARS } from '../convention-files.js';
import {
  TraitsSchema,
  AgentManifestSchema,
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

describe('TraitsSchema — invalid range', () => {
  it('rejects verbosity value of 0 (below minimum)', () => {
    expect(() => TraitsSchema.parse({ verbosity: 0 })).toThrow();
  });
});

describe('AgentManifestSchema — traits field', () => {
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
});

describe('AgentManifestSchema — existing manifests without personality fields still parse', () => {
  it('parses a minimal manifest without traits or conventions', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.id).toBe('agent-001');
    expect(result.traits).toBeUndefined();
    expect(result.conventions).toBeUndefined();
  });
});

describe('UpdateAgentConventionsSchema', () => {
  it('rejects soulContent exceeding 4000 chars', () => {
    expect(() => UpdateAgentConventionsSchema.parse({ soulContent: 'a'.repeat(4001) })).toThrow();
  });

  // The wire is the OTHER writable path into MEMORY.md. The tool refuses a
  // write past the cap; without this, the in-app editor could produce a file the
  // injector has to truncate — the degradation that is meant to be reachable
  // only by editing the file on disk, where DorkOS genuinely cannot intervene.
  //
  // Both directions, because a rejection-only test passes for a schema that
  // rejects everything, and an acceptance-only test passes for one with no cap.
  it('accepts memoryContent exactly at the cap and refuses one character past it', () => {
    const atCap = UpdateAgentConventionsSchema.parse({
      memoryContent: 'm'.repeat(MEMORY_MAX_CHARS),
    });
    expect(atCap.memoryContent).toHaveLength(MEMORY_MAX_CHARS);

    expect(() =>
      UpdateAgentConventionsSchema.parse({ memoryContent: 'm'.repeat(MEMORY_MAX_CHARS + 1) })
    ).toThrow();
  });
});
