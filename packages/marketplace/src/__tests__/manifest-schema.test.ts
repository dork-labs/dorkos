import { describe, it, expect } from 'vitest';
import {
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
  type PluginPackageManifest,
  type AgentPackageManifest,
  type SkillPackPackageManifest,
  type AdapterPackageManifest,
} from '../manifest-schema.js';

const baseFields = {
  name: 'my-package',
  version: '1.0.0',
  description: 'A test package',
};

describe('MarketplacePackageManifestSchema — valid manifests', () => {
  it('accepts a minimal plugin manifest and applies defaults', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'plugin',
    });

    expect(result.type).toBe('plugin');
    expect(result.schemaVersion).toBe(1);
    expect(result.tags).toEqual([]);
    expect(result.layers).toEqual([]);
    expect(result.requires).toEqual([]);

    // Discriminated union narrowing — `extensions` is plugin-only.
    if (result.type === 'plugin') {
      expect(result.extensions).toEqual([]);
      // Type-level assertion that the narrowed type satisfies PluginPackageManifest.
      const narrowed = result satisfies PluginPackageManifest;
      expect(narrowed.extensions).toEqual([]);
    } else {
      throw new Error('expected plugin variant');
    }
  });

  it('accepts a minimal agent manifest', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'agent',
    });

    expect(result.type).toBe('agent');
    expect(result.schemaVersion).toBe(1);

    if (result.type === 'agent') {
      // agentDefaults is optional and may be undefined when absent.
      expect(result.agentDefaults).toBeUndefined();
      const narrowed = result satisfies AgentPackageManifest;
      expect(narrowed.type).toBe('agent');
    } else {
      throw new Error('expected agent variant');
    }
  });

  it('accepts an agent manifest with full agentDefaults', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'agent',
      agentDefaults: {
        persona: 'a thoughtful reviewer',
        capabilities: ['code-review', 'refactor'],
        traits: { tone: 3, autonomy: 4, caution: 5, communication: 4, creativity: 2 },
      },
    });

    if (result.type !== 'agent') throw new Error('expected agent variant');
    expect(result.agentDefaults?.persona).toBe('a thoughtful reviewer');
    expect(result.agentDefaults?.capabilities).toEqual(['code-review', 'refactor']);
    expect(result.agentDefaults?.traits?.tone).toBe(3);
  });

  it('accepts a minimal skill-pack manifest', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'skill-pack',
    });

    expect(result.type).toBe('skill-pack');

    if (result.type === 'skill-pack') {
      const narrowed = result satisfies SkillPackPackageManifest;
      expect(narrowed.type).toBe('skill-pack');
    } else {
      throw new Error('expected skill-pack variant');
    }
  });

  it('accepts a minimal adapter manifest with adapterType', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'adapter',
      adapterType: 'slack',
    });

    expect(result.type).toBe('adapter');

    if (result.type === 'adapter') {
      expect(result.adapterType).toBe('slack');
      const narrowed = result satisfies AdapterPackageManifest;
      expect(narrowed.adapterType).toBe('slack');
    } else {
      throw new Error('expected adapter variant');
    }
  });

  it('accepts all common optional fields', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'plugin',
      displayName: 'My Package',
      author: 'Test Author',
      license: 'MIT',
      repository: 'https://github.com/test/test',
      homepage: 'https://example.com',
      tags: ['cli', 'ops'],
      category: 'devtools',
      icon: '🛠️',
      minDorkosVersion: '0.5.0',
      layers: ['skills', 'commands'],
      requires: ['adapter:slack@^1.0.0'],
      featured: true,
    });

    expect(result.tags).toEqual(['cli', 'ops']);
    expect(result.layers).toEqual(['skills', 'commands']);
    expect(result.requires).toEqual(['adapter:slack@^1.0.0']);
    expect(result.featured).toBe(true);
    expect(result.minDorkosVersion).toBe('0.5.0');
  });

  it('produces a value compatible with the union type', () => {
    const result: MarketplacePackageManifest = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'plugin',
    });
    expect(result.name).toBe('my-package');
  });
});

describe('MarketplacePackageManifestSchema — default value application', () => {
  it('defaults schemaVersion to 1 when omitted', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'plugin',
    });
    expect(result.schemaVersion).toBe(1);
  });

  it('defaults tags to []', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'skill-pack',
    });
    expect(result.tags).toEqual([]);
  });

  it('defaults layers to []', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'skill-pack',
    });
    expect(result.layers).toEqual([]);
  });

  it('defaults requires to []', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'skill-pack',
    });
    expect(result.requires).toEqual([]);
  });

  it('defaults plugin.extensions to []', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'plugin',
    });
    if (result.type !== 'plugin') throw new Error('expected plugin variant');
    expect(result.extensions).toEqual([]);
  });

  it('defaults agent.agentDefaults.capabilities to [] when agentDefaults is given without capabilities', () => {
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'agent',
      agentDefaults: {},
    });
    if (result.type !== 'agent') throw new Error('expected agent variant');
    expect(result.agentDefaults?.capabilities).toEqual([]);
  });
});

describe('MarketplacePackageManifestSchema — invalid manifests', () => {
  it('rejects manifests missing name', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      version: '1.0.0',
      description: 'desc',
      type: 'plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects names containing uppercase letters', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      name: 'My-Package',
      type: 'plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects version "1.0" (not a full semver)', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      version: '1.0',
      type: 'plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects version "abc"', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      version: 'abc',
      type: 'plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects type values outside the enum', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'extension',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an adapter manifest missing adapterType', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'adapter',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an adapter manifest with empty adapterType', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'adapter',
      adapterType: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty description', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      description: '',
      type: 'plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a description longer than 1024 characters', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      description: 'a'.repeat(1025),
      type: 'plugin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects tags arrays with more than 20 entries', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('accepts tags arrays with exactly 20 entries', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(true);
  });

  it('rejects category longer than 64 characters', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      category: 'c'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown layer value', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      layers: ['not-a-real-layer'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed repository URLs', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      repository: 'not a url',
    });
    expect(result.success).toBe(false);
  });
});

describe('MarketplacePackageManifestSchema — dependency declaration format', () => {
  const validDependencies = [
    'adapter:slack',
    'adapter:slack@^1.0.0',
    'plugin:linear-integration',
    'skill-pack:writer',
    'agent:code-reviewer',
    'plugin:foo@1.2.3',
    'skill-pack:bar@~2.0.0',
  ];

  it.each(validDependencies)('accepts valid dependency declaration: %s', (dep) => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      requires: [dep],
    });
    expect(result.success).toBe(true);
  });

  const invalidDependencies = [
    'slack',
    'adapter:Slack',
    'adapter:slack@',
    'random:foo',
    'adapter:',
    ':slack',
    'adapter:-slack',
    '',
  ];

  it.each(invalidDependencies)('rejects invalid dependency declaration: %s', (dep) => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      requires: [dep],
    });
    expect(result.success).toBe(false);
  });
});
