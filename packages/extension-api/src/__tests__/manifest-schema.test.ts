import { describe, it, expect } from 'vitest';
import { ExtensionManifestSchema } from '../manifest-schema.js';

describe('ExtensionManifestSchema', () => {
  // --- Valid manifests ---

  it('parses a complete valid manifest', () => {
    const manifest = {
      id: 'github-prs',
      name: 'GitHub PR Dashboard',
      version: '1.0.0',
      description: 'Shows pending PR reviews',
      author: 'dorkbot',
      minHostVersion: '0.1.0',
      contributions: { 'dashboard.sections': true },
      permissions: ['storage'],
    };
    const result = ExtensionManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('parses a minimal manifest (only required fields)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'hello-world',
      name: 'Hello World',
      version: '0.1.0',
    });
    expect(result.success).toBe(true);
  });

  it('parses an id with numbers', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'my-plugin-v2',
      name: 'My Plugin V2',
      version: '2.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('parses a single-word lowercase id', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'analytics',
      name: 'Analytics',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  // --- Invalid IDs ---

  it('rejects an ID with uppercase letters', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'MyPlugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ID with spaces', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'my plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty string ID', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: '',
      name: 'No ID',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ID starting with a hyphen', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: '-my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ID with special characters', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'my_plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  // --- Invalid versions ---

  it('rejects a non-semver version string "latest"', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: 'latest',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a version with "v" prefix', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: 'v1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a version with only two parts', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0',
    });
    expect(result.success).toBe(false);
  });

  // --- Missing required fields ---

  it('rejects when required field id is missing', () => {
    const result = ExtensionManifestSchema.safeParse({
      name: 'No ID',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when required field name is missing', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-name',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when required field version is missing', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-version',
      name: 'No Version',
    });
    expect(result.success).toBe(false);
  });

  // --- Optional fields ---

  it('treats description as optional', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      description: 'A description',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('A description');
    }
  });

  it('treats author as optional', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      author: 'Alice',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBe('Alice');
    }
  });

  it('treats minHostVersion as optional', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      minHostVersion: '0.2.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minHostVersion).toBe('0.2.0');
    }
  });

  // --- Contributions record ---

  it('parses a contributions record correctly', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'dashboard-ext',
      name: 'Dashboard Extension',
      version: '1.0.0',
      contributions: { 'dashboard.sections': true, 'sidebar.footer': false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributions).toEqual({
        'dashboard.sections': true,
        'sidebar.footer': false,
      });
    }
  });

  // --- Permissions array ---

  it('parses a permissions array correctly', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'network-ext',
      name: 'Network Extension',
      version: '1.0.0',
      permissions: ['storage', 'network'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions).toEqual(['storage', 'network']);
    }
  });

  it('parses an empty permissions array', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'minimal-ext',
      name: 'Minimal Extension',
      version: '1.0.0',
      permissions: [],
    });
    expect(result.success).toBe(true);
  });
});
