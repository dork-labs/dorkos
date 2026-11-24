import { describe, it, expect } from 'vitest';
import {
  MarketplacePackageManifestSchema,
  CONNECTOR_ADAPTER_TYPE,
  type PluginPackageManifest,
  type AgentPackageManifest,
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

  it('accepts a connector adapter manifest (adapterType: connector) and lets another package depend on it', () => {
    // The connector distribution convention (connector-gateway spec §Detailed
    // Design 6): a ConnectorProvider gateway ships as a normal adapter package
    // with the well-known `adapterType: 'connector'` — no PackageTypeSchema
    // change — and is depended on via the existing adapter dependency grammar.
    const result = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      name: 'connector-composio',
      type: 'adapter',
      adapterType: CONNECTOR_ADAPTER_TYPE,
      displayName: 'Composio Connector',
      requires: ['skill-pack:some-tools@^1.0.0'],
    });

    expect(result.type).toBe('adapter');
    if (result.type === 'adapter') {
      expect(result.adapterType).toBe('connector');
      const narrowed = result satisfies AdapterPackageManifest;
      expect(narrowed.adapterType).toBe(CONNECTOR_ADAPTER_TYPE);
    } else {
      throw new Error('expected adapter variant');
    }

    // A consumer declares the dependency on the connector adapter by name.
    const consumer = MarketplacePackageManifestSchema.parse({
      ...baseFields,
      type: 'plugin',
      requires: ['adapter:connector-composio@^1.0.0'],
    });
    expect(consumer.requires).toEqual(['adapter:connector-composio@^1.0.0']);
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
});

describe('MarketplacePackageManifestSchema — categories + coherence', () => {
  // Harness regression guard (§B2 / DOR-264): the singular `category` stays a
  // lenient z.string(), so a package installed before the taxonomy shipped —
  // carrying a legacy free-string category and NO categories[] — must still
  // parse. Tightening the singular field to the enum would make every such
  // installed package invisible to Harness projection.
  it('accepts a legacy free-string singular-only category', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      category: 'workflow',
    });
    expect(result.success, 'legacy free-string category must still parse').toBe(true);
  });

  // The enum binds categories[] only: an off-list entry there fails.
  it('rejects an off-list entry inside categories[]', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      categories: ['not-a-cat'],
    });
    expect(result.success).toBe(false);
  });

  // Coherence refine: when both are present, the singular category must equal
  // the primary (categories[0]).
  it('rejects an incoherent category / categories[0] pair', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      category: 'code-review',
      categories: ['security', 'code-review'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['category']);
    }
  });

  it('accepts a coherent category / categories[0] pair', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      type: 'plugin',
      category: 'security',
      categories: ['security', 'code-review'],
    });
    expect(result.success).toBe(true);
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

  it('rejects an empty description', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      ...baseFields,
      description: '',
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
