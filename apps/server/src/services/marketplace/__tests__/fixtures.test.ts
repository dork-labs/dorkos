import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '@dorkos/marketplace/package-validator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const VALID_FIXTURES = [
  'valid-plugin',
  'valid-agent',
  'valid-skill-pack',
  'valid-adapter',
] as const;

const BROKEN_FIXTURES = [
  'invalid-manifest',
  'missing-extension-code',
  'conflicting-skill',
] as const;

describe('marketplace install fixtures', () => {
  describe('valid fixtures', () => {
    it.each(VALID_FIXTURES)('parses cleanly: %s', async (name) => {
      const result = await validatePackage(path.join(FIXTURES_DIR, name));

      expect(result.ok).toBe(true);
      expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(result.manifest).toBeDefined();
      expect(result.manifest?.name).toBe(name);
    });
  });

  describe('broken fixtures', () => {
    it.each(BROKEN_FIXTURES)('fails validation: %s', async (name) => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'broken', name));

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.level === 'error')).toBe(true);
    });
  });
});
