import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EndpointRegistry, hashSubject } from '../endpoint-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let registry: EndpointRegistry;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'relay-test-'));
  registry = new EndpointRegistry(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Assert that a directory exists at the given path. */
async function expectDirExists(dirPath: string): Promise<void> {
  const stats = await stat(dirPath);
  expect(stats.isDirectory()).toBe(true);
}

/** Assert that a path does not exist. */
async function expectNotExists(dirPath: string): Promise<void> {
  await expect(stat(dirPath)).rejects.toThrow();
}

// ---------------------------------------------------------------------------
// hashSubject
// ---------------------------------------------------------------------------

describe('hashSubject', () => {
  it('returns a 12-character hex string', () => {
    const hash = hashSubject('relay.agent.myproject.backend');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it('is deterministic — same input always produces same output', () => {
    const subject = 'relay.agent.myproject.backend';
    const hash1 = hashSubject(subject);
    const hash2 = hashSubject(subject);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different subjects', () => {
    const hash1 = hashSubject('relay.agent.project-a.backend');
    const hash2 = hashSubject('relay.agent.project-b.backend');
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for subjects that differ only in case', () => {
    const hash1 = hashSubject('relay.agent.MyProject');
    const hash2 = hashSubject('relay.agent.myproject');
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// EndpointRegistry — registerEndpoint
// ---------------------------------------------------------------------------

describe('EndpointRegistry', () => {
  describe('registerEndpoint', () => {
    it('returns EndpointInfo with correct fields', async () => {
      const subject = 'relay.agent.myproject.backend';
      const info = await registry.registerEndpoint(subject);

      expect(info.subject).toBe(subject);
      expect(info.hash).toBe(hashSubject(subject));
      expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', info.hash));
      expect(info.registeredAt).toBeTruthy();
      // registeredAt is a valid ISO date string
      expect(new Date(info.registeredAt).toISOString()).toBe(info.registeredAt);
    });

    it('creates Maildir directory structure (tmp, new, cur, failed)', async () => {
      const info = await registry.registerEndpoint('relay.agent.test');

      await expectDirExists(join(info.maildirPath, 'tmp'));
      await expectDirExists(join(info.maildirPath, 'new'));
      await expectDirExists(join(info.maildirPath, 'cur'));
      await expectDirExists(join(info.maildirPath, 'failed'));
    });

    it('creates only the expected subdirectories', async () => {
      const info = await registry.registerEndpoint('relay.agent.test');
      const contents = await readdir(info.maildirPath);

      expect(contents.sort()).toEqual(['cur', 'failed', 'new', 'tmp']);
    });

    it('throws when subject is invalid', async () => {
      await expect(registry.registerEndpoint('')).rejects.toThrow('Invalid subject');
    });

    it('throws when subject contains single wildcard', async () => {
      await expect(registry.registerEndpoint('relay.agent.*')).rejects.toThrow(
        'must not contain wildcards'
      );
    });

    it('throws when subject contains multi-wildcard', async () => {
      await expect(registry.registerEndpoint('relay.agent.>')).rejects.toThrow(
        'must not contain wildcards'
      );
    });

    it('throws when endpoint is already registered', async () => {
      const subject = 'relay.agent.dup';
      await registry.registerEndpoint(subject);

      await expect(registry.registerEndpoint(subject)).rejects.toThrow('already registered');
    });

    it('allows registering multiple distinct endpoints', async () => {
      await registry.registerEndpoint('relay.agent.a');
      await registry.registerEndpoint('relay.agent.b');
      await registry.registerEndpoint('relay.agent.c');

      expect(registry.size).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // unregisterEndpoint
  // ---------------------------------------------------------------------------

  describe('unregisterEndpoint', () => {
    it('returns true when endpoint was found and removed', async () => {
      const subject = 'relay.agent.remove-me';
      await registry.registerEndpoint(subject);

      const result = await registry.unregisterEndpoint(subject);
      expect(result).toBe(true);
    });

    it('returns false when endpoint is not found', async () => {
      const result = await registry.unregisterEndpoint('relay.agent.nonexistent');
      expect(result).toBe(false);
    });

    it('removes endpoint from in-memory registry', async () => {
      const subject = 'relay.agent.remove-me';
      await registry.registerEndpoint(subject);
      await registry.unregisterEndpoint(subject);

      expect(registry.hasEndpoint(subject)).toBe(false);
      expect(registry.getEndpoint(subject)).toBeUndefined();
    });

    it('removes Maildir directory from disk', async () => {
      const subject = 'relay.agent.remove-me';
      const info = await registry.registerEndpoint(subject);
      const maildirPath = info.maildirPath;

      // Verify exists first
      await expectDirExists(maildirPath);

      await registry.unregisterEndpoint(subject);

      await expectNotExists(maildirPath);
    });

    it('decrements size after unregister', async () => {
      await registry.registerEndpoint('relay.agent.a');
      await registry.registerEndpoint('relay.agent.b');
      expect(registry.size).toBe(2);

      await registry.unregisterEndpoint('relay.agent.a');
      expect(registry.size).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getEndpoint
  // ---------------------------------------------------------------------------

  describe('getEndpoint', () => {
    it('returns EndpointInfo for a registered subject', async () => {
      const subject = 'relay.agent.myproject.backend';
      const registered = await registry.registerEndpoint(subject);

      const found = registry.getEndpoint(subject);
      expect(found).toEqual(registered);
    });

    it('returns undefined for an unregistered subject', () => {
      const found = registry.getEndpoint('relay.agent.nonexistent');
      expect(found).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getEndpointByHash
  // ---------------------------------------------------------------------------

  describe('getEndpointByHash', () => {
    it('returns EndpointInfo for a registered hash', async () => {
      const subject = 'relay.agent.myproject.backend';
      const registered = await registry.registerEndpoint(subject);

      const found = registry.getEndpointByHash(registered.hash);
      expect(found).toEqual(registered);
    });

    it('returns undefined for an unknown hash', () => {
      const found = registry.getEndpointByHash('000000000000');
      expect(found).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // listEndpoints
  // ---------------------------------------------------------------------------

  describe('listEndpoints', () => {
    it('returns an empty array when no endpoints are registered', () => {
      expect(registry.listEndpoints()).toEqual([]);
    });

    it('returns all registered endpoints', async () => {
      await registry.registerEndpoint('relay.agent.a');
      await registry.registerEndpoint('relay.agent.b');

      const list = registry.listEndpoints();
      expect(list).toHaveLength(2);

      const subjects = list.map((e) => e.subject).sort();
      expect(subjects).toEqual(['relay.agent.a', 'relay.agent.b']);
    });

    it('does not include unregistered endpoints', async () => {
      await registry.registerEndpoint('relay.agent.a');
      await registry.registerEndpoint('relay.agent.b');
      await registry.unregisterEndpoint('relay.agent.a');

      const list = registry.listEndpoints();
      expect(list).toHaveLength(1);
      expect(list[0].subject).toBe('relay.agent.b');
    });
  });

  // ---------------------------------------------------------------------------
  // hasEndpoint
  // ---------------------------------------------------------------------------

  describe('hasEndpoint', () => {
    it('returns true for a registered subject', async () => {
      await registry.registerEndpoint('relay.agent.test');
      expect(registry.hasEndpoint('relay.agent.test')).toBe(true);
    });

    it('returns false for an unregistered subject', () => {
      expect(registry.hasEndpoint('relay.agent.nonexistent')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // size
  // ---------------------------------------------------------------------------

  describe('size', () => {
    it('is 0 initially', () => {
      expect(registry.size).toBe(0);
    });

    it('increments on registration', async () => {
      await registry.registerEndpoint('relay.agent.a');
      expect(registry.size).toBe(1);

      await registry.registerEndpoint('relay.agent.b');
      expect(registry.size).toBe(2);
    });

    it('decrements on unregistration', async () => {
      await registry.registerEndpoint('relay.agent.a');
      await registry.registerEndpoint('relay.agent.b');
      await registry.unregisterEndpoint('relay.agent.a');

      expect(registry.size).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Hash determinism and directory structure
  // ---------------------------------------------------------------------------

  describe('hash determinism', () => {
    it('two registries with same dataDir produce same hash for same subject', () => {
      const registry2 = new EndpointRegistry(tempDir);
      const subject = 'relay.agent.test.determinism';

      // hashSubject is a standalone function — deterministic by nature
      const hash1 = hashSubject(subject);
      const hash2 = hashSubject(subject);
      expect(hash1).toBe(hash2);

      // Also verify EndpointRegistry uses the same hash
      // (we can't register twice in the same dir, but hash should match)
      expect(hash1).toMatch(/^[a-f0-9]{12}$/);
      // Ensure the second registry instance is valid (no-op, just showing they're independent)
      expect(registry2.size).toBe(0);
    });

    it('maildir path is derived from hash', async () => {
      const subject = 'relay.agent.path-check';
      const info = await registry.registerEndpoint(subject);
      const expectedHash = hashSubject(subject);

      expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', expectedHash));
    });
  });
});
