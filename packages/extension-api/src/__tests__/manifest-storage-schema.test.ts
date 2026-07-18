import { describe, it, expect } from 'vitest';
import {
  StorageMigrationSchema,
  StorageDeclarationSchema,
  ExtensionManifestSchema,
} from '../manifest-schema.js';

describe('StorageMigrationSchema', () => {
  it('accepts a minimal migration (version + up only)', () => {
    // The smallest valid migration: a 1-based version and a non-empty body.
    const result = StorageMigrationSchema.safeParse({
      version: 1,
      up: 'CREATE TABLE t (id TEXT PRIMARY KEY)',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a migration with an optional name', () => {
    // `name` is a human note surfaced in migration logs/errors.
    const result = StorageMigrationSchema.safeParse({
      version: 2,
      name: 'add index',
      up: 'CREATE INDEX idx ON t (id)',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a zero version (must be positive)', () => {
    // Versions are 1-based; 0 is never a valid migration version.
    const result = StorageMigrationSchema.safeParse({ version: 0, up: 'CREATE TABLE t (id TEXT)' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative version', () => {
    // Negative versions cannot exist in a monotonic 1..N sequence.
    const result = StorageMigrationSchema.safeParse({
      version: -1,
      up: 'CREATE TABLE t (id TEXT)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer version', () => {
    // A fractional version breaks the monotonic 1..N invariant.
    const result = StorageMigrationSchema.safeParse({
      version: 1.5,
      up: 'CREATE TABLE t (id TEXT)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty up body', () => {
    // An empty migration body has nothing to apply — reject at parse time.
    const result = StorageMigrationSchema.safeParse({ version: 1, up: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key on a migration (.strict())', () => {
    // `.strict()` catches typos like `down` rather than silently ignoring them.
    const result = StorageMigrationSchema.safeParse({
      version: 1,
      up: 'CREATE TABLE t (id TEXT)',
      down: 'DROP TABLE t',
    });
    expect(result.success).toBe(false);
  });
});

describe('StorageDeclarationSchema', () => {
  it('accepts a valid 1..N migration array without quotaBytes', () => {
    // The quota is optional (host default applies); migrations 1..3 are in order.
    const result = StorageDeclarationSchema.safeParse({
      migrations: [
        { version: 1, up: 'CREATE TABLE a (id TEXT)' },
        { version: 2, up: 'CREATE TABLE b (id TEXT)' },
        { version: 3, up: 'CREATE TABLE c (id TEXT)' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a declaration with quotaBytes and named migrations', () => {
    // Both optional fields present: quotaBytes and per-migration name.
    const result = StorageDeclarationSchema.safeParse({
      quotaBytes: 26214400,
      migrations: [{ version: 1, name: 'initial', up: 'CREATE TABLE a (id TEXT)' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty migrations array', () => {
    // A storage block declaring no migrations yet is structurally valid.
    const result = StorageDeclarationSchema.safeParse({ migrations: [] });
    expect(result.success).toBe(true);
  });

  it('rejects a version gap ([1, 3])', () => {
    // Migrations must be contiguous 1..N — a gap means a version is missing.
    const result = StorageDeclarationSchema.safeParse({
      migrations: [
        { version: 1, up: 'CREATE TABLE a (id TEXT)' },
        { version: 3, up: 'CREATE TABLE c (id TEXT)' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate versions ([1, 1])', () => {
    // Two migrations at the same version violate the monotonic ordering.
    const result = StorageDeclarationSchema.safeParse({
      migrations: [
        { version: 1, up: 'CREATE TABLE a (id TEXT)' },
        { version: 1, up: 'CREATE TABLE b (id TEXT)' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-order sequence ([2, 1])', () => {
    // The array order must match the version order (index + 1 === version).
    const result = StorageDeclarationSchema.safeParse({
      migrations: [
        { version: 2, up: 'CREATE TABLE b (id TEXT)' },
        { version: 1, up: 'CREATE TABLE a (id TEXT)' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a sequence not starting at 1 ([2])', () => {
    // The first migration must be version 1.
    const result = StorageDeclarationSchema.safeParse({
      migrations: [{ version: 2, up: 'CREATE TABLE b (id TEXT)' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero/negative quotaBytes', () => {
    // A quota must be a positive byte count.
    const result = StorageDeclarationSchema.safeParse({
      quotaBytes: 0,
      migrations: [{ version: 1, up: 'CREATE TABLE a (id TEXT)' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key on the declaration (.strict())', () => {
    // `.strict()` rejects unknown top-level keys on the storage block.
    const result = StorageDeclarationSchema.safeParse({
      migrations: [{ version: 1, up: 'CREATE TABLE a (id TEXT)' }],
      maxRows: 500,
    });
    expect(result.success).toBe(false);
  });
});

describe('ExtensionManifestSchema — storage block', () => {
  it('parses a manifest with a valid storage block', () => {
    // The storage block round-trips through the full manifest schema.
    const result = ExtensionManifestSchema.safeParse({
      id: 'crm-lite',
      name: 'CRM Lite',
      version: '1.0.0',
      storage: {
        quotaBytes: 26214400,
        migrations: [
          {
            version: 1,
            name: 'contacts + pipeline',
            up: 'CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE deals (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL);',
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storage?.migrations).toHaveLength(1);
      expect(result.data.storage?.quotaBytes).toBe(26214400);
    }
  });

  it('parses a manifest with no storage block (optional)', () => {
    // storage is optional — existing manifests without it stay valid.
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-storage',
      name: 'No Storage',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storage).toBeUndefined();
    }
  });

  it('rejects a manifest whose storage block has a version gap', () => {
    // The 1..N refinement propagates up through the manifest schema.
    const result = ExtensionManifestSchema.safeParse({
      id: 'gap-storage',
      name: 'Gap Storage',
      version: '1.0.0',
      storage: {
        migrations: [
          { version: 1, up: 'CREATE TABLE a (id TEXT)' },
          { version: 3, up: 'CREATE TABLE c (id TEXT)' },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});
