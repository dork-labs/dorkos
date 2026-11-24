import { describe, it, expect } from 'vitest';
import { AdapterManifestSchema, CatalogEntrySchema } from '../relay-schemas.js';

const claudeCodeManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Routes messages to Claude Agent SDK sessions.',
  iconId: 'claude-code',
  category: 'internal' as const,
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'maxConcurrent',
      label: 'Max Concurrent Sessions',
      type: 'number',
      required: false,
      default: 3,
    },
  ],
};

describe('AdapterManifestSchema', () => {
  it('defaults multiInstance to false when omitted', () => {
    const manifest = {
      type: 'custom',
      displayName: 'Custom',
      description: 'A custom adapter.',
      category: 'custom',
      builtin: false,
      configFields: [],
    };
    const result = AdapterManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiInstance).toBe(false);
    }
  });
});

describe('CatalogEntrySchema', () => {
  it('parses a catalog entry with instances', () => {
    const result = CatalogEntrySchema.safeParse({
      manifest: claudeCodeManifest,
      instances: [
        {
          id: 'claude-code-1',
          enabled: true,
          status: {
            id: 'claude-code-1',
            type: 'claude-code',
            displayName: 'Claude Code',
            state: 'connected',
            messageCount: { inbound: 10, outbound: 5 },
            errorCount: 0,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instances).toHaveLength(1);
      expect(result.data.instances[0].status.state).toBe('connected');
    }
  });
});
