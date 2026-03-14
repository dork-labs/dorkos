import { describe, it, expect } from 'vitest';
import { ConfigFieldSchema, AdapterManifestSchema } from '../relay-adapter-schemas.js';

describe('ConfigFieldSchema', () => {
  const baseField = {
    key: 'token',
    label: 'Bot Token',
    type: 'password' as const,
    required: true,
  };

  it('accepts field without helpMarkdown (backward compat)', () => {
    const result = ConfigFieldSchema.safeParse(baseField);
    expect(result.success).toBe(true);
  });

  it('accepts field with helpMarkdown string', () => {
    const result = ConfigFieldSchema.safeParse({
      ...baseField,
      helpMarkdown: '1. Go to **Settings**\n2. Copy the token',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.helpMarkdown).toBe('1. Go to **Settings**\n2. Copy the token');
    }
  });

  it('rejects non-string helpMarkdown', () => {
    const result = ConfigFieldSchema.safeParse({
      ...baseField,
      helpMarkdown: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe('AdapterManifestSchema', () => {
  const baseManifest = {
    type: 'test',
    displayName: 'Test Adapter',
    description: 'A test adapter.',
    category: 'messaging' as const,
    builtin: true,
    configFields: [{
      key: 'token',
      label: 'Token',
      type: 'password' as const,
      required: true,
    }],
  };

  it('accepts manifest without setupGuide (backward compat)', () => {
    const result = AdapterManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('accepts manifest with setupGuide string', () => {
    const result = AdapterManifestSchema.safeParse({
      ...baseManifest,
      setupGuide: '# Quick Start\n\nFollow these steps...',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setupGuide).toBe('# Quick Start\n\nFollow these steps...');
    }
  });

  it('rejects non-string setupGuide', () => {
    const result = AdapterManifestSchema.safeParse({
      ...baseManifest,
      setupGuide: 123,
    });
    expect(result.success).toBe(false);
  });
});
