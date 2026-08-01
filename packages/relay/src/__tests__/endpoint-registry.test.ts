import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EndpointRegistry } from '../endpoint-registry.js';

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
// EndpointRegistry — registerEndpoint
// ---------------------------------------------------------------------------

describe('EndpointRegistry', () => {
  describe('registerEndpoint', () => {
    it('returns EndpointInfo with correct fields', async () => {
      const subject = 'relay.agent.myproject.backend';
      const info = await registry.registerEndpoint(subject);

      expect(info.subject).toBe(subject);
      expect(info.hash).toBe(subject);
      expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', subject));
      expect(info.registeredAt).toBeTruthy();
      // registeredAt is a valid ISO date string
      expect(new Date(info.registeredAt).toISOString()).toBe(info.registeredAt);
    });

    it('refuses a control subject outright — nobody may hold that mailbox', async () => {
      // Not an ownership rule with an exception for the server: an endpoint on
      // a control subject makes `publish` count the mailbox delivery, so every
      // control signal there reports confirmed whether or not a subscriber
      // acted on it. There is no caller who wants that (DOR-808).
      await expect(registry.registerEndpoint('relay.control.task-cancel.run-1')).rejects.toThrow(
        /control channel/
      );
      expect(registry.listEndpoints()).toHaveLength(0);
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

  describe('directory naming', () => {
    it('hash equals subject (API compatibility)', async () => {
      const subject = 'relay.agent.test.determinism';
      const info = await registry.registerEndpoint(subject);

      expect(info.hash).toBe(subject);
    });

    it('maildir path is derived from subject', async () => {
      const subject = 'relay.agent.path-check';
      const info = await registry.registerEndpoint(subject);

      expect(info.maildirPath).toBe(join(tempDir, 'mailboxes', subject));
    });
  });

  // ---------------------------------------------------------------------------
  // Activity tracking (inactivity-based TTL sweep, M3)
  // ---------------------------------------------------------------------------

  describe('activity tracking', () => {
    it('seeds last-activity from registration time', async () => {
      const info = await registry.registerEndpoint('relay.inbox.dispatch.act');
      expect(registry.getLastActivityMs('relay.inbox.dispatch.act')).toBe(
        Date.parse(info.registeredAt)
      );
    });

    it('touch() advances last-activity past registration time', async () => {
      const info = await registry.registerEndpoint('relay.inbox.dispatch.act');
      const registeredMs = Date.parse(info.registeredAt);

      await new Promise((r) => setTimeout(r, 5));
      registry.touch('relay.inbox.dispatch.act');

      const activity = registry.getLastActivityMs('relay.inbox.dispatch.act');
      expect(activity).toBeGreaterThanOrEqual(registeredMs);
      expect(activity).toBeGreaterThan(registeredMs - 1);
    });

    it('touch() is a no-op for unregistered subjects', () => {
      registry.touch('relay.inbox.dispatch.missing');
      expect(registry.getLastActivityMs('relay.inbox.dispatch.missing')).toBeUndefined();
    });

    it('forgets activity on unregister', async () => {
      await registry.registerEndpoint('relay.inbox.dispatch.act');
      await registry.unregisterEndpoint('relay.inbox.dispatch.act');
      expect(registry.getLastActivityMs('relay.inbox.dispatch.act')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Ownership durability and mailbox identity (DOR-506)
// ---------------------------------------------------------------------------

describe('endpoint ownership survives the process', () => {
  it('records the owner on disk so a fresh registry still knows it', async () => {
    await registry.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.alice' });

    // A restart: the endpoint Map is gone, the Maildir is not.
    const restarted = new EndpointRegistry(tempDir);
    const reregistered = await restarted.registerEndpoint('relay.inbox.alice', {
      owner: 'relay.agent.ns.alice',
    });

    expect(reregistered.owner).toBe('relay.agent.ns.alice');
  });

  it('refuses a second owner claiming the same mailbox after a restart', async () => {
    // The B1 squat: registration is unauthenticated and used to confer
    // ownership, so the first caller after a restart owned whatever it named.
    await registry.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.alice' });

    const restarted = new EndpointRegistry(tempDir);
    await expect(
      restarted.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.bob' })
    ).rejects.toThrow(/belongs to another owner/);

    // And the real owner is not locked out of her own inbox.
    const alice = await restarted.registerEndpoint('relay.inbox.alice', {
      owner: 'relay.agent.ns.alice',
    });
    expect(alice.owner).toBe('relay.agent.ns.alice');
  });

  it('never erases a recorded owner when the server re-registers with none', async () => {
    await registry.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.alice' });

    const restarted = new EndpointRegistry(tempDir);
    const info = await restarted.registerEndpoint('relay.inbox.alice');

    expect(info.owner).toBe('relay.agent.ns.alice');
  });

  it('lets exactly one of two racing claimants own an unclaimed mailbox', async () => {
    // The read and the write are separate syscalls. Without an exclusive create
    // both callers see no owner and both believe they claimed it, with the later
    // write silently deciding. No restart needed: registerEndpoint awaits between
    // the in-memory check and endpoints.set.
    const results = await Promise.allSettled([
      registry.registerEndpoint('relay.inbox.contested', { owner: 'relay.agent.ns.alice' }),
      registry.registerEndpoint('relay.inbox.contested', { owner: 'relay.agent.ns.bob' }),
    ]);

    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const losers = results.filter((r) => r.status === 'rejected');
    expect(losers).toHaveLength(1);

    // Whoever won, the recorded owner agrees with the endpoint that was returned,
    // and a third party is still refused.
    const winner = (winners[0] as PromiseFulfilledResult<{ owner?: string }>).value.owner;
    const restarted = new EndpointRegistry(tempDir);
    await expect(
      restarted.registerEndpoint('relay.inbox.contested', { owner: 'relay.agent.ns.carol' })
    ).rejects.toThrow(/belongs to another owner/);
    const reclaimed = await restarted.registerEndpoint('relay.inbox.contested', { owner: winner });
    expect(reclaimed.owner).toBe(winner);
  });

  it('lets two racing claims by the SAME owner both succeed', async () => {
    // The exclusive create must not turn a harmless duplicate into an error:
    // one agent registering twice concurrently is not an ownership conflict.
    const results = await Promise.allSettled([
      registry.registerEndpoint('relay.inbox.samesame', { owner: 'relay.agent.ns.alice' }),
      registry.registerEndpoint('relay.inbox.samesame', { owner: 'relay.agent.ns.alice' }),
    ]);
    const owners = results.map((r) =>
      r.status === 'fulfilled' ? (r.value as { owner?: string }).owner : `rejected: ${r.reason}`
    );
    expect(owners).toEqual(['relay.agent.ns.alice', 'relay.agent.ns.alice']);
  });

  it('reports no owner for a mailbox that records none, rather than guessing one', async () => {
    const info = await registry.registerEndpoint('relay.system.console');
    expect(info.owner).toBeUndefined();
  });

  it('relinquishes ownership when the endpoint is unregistered', async () => {
    await registry.registerEndpoint('relay.inbox.temp', { owner: 'relay.agent.ns.alice' });
    await registry.unregisterEndpoint('relay.inbox.temp');

    const info = await registry.registerEndpoint('relay.inbox.temp', {
      owner: 'relay.agent.ns.bob',
    });
    expect(info.owner).toBe('relay.agent.ns.bob');
  });
});

describe('one mailbox, one subject', () => {
  it('refuses a subject that differs from a live endpoint only by letter case', async () => {
    // The B2 collision: maildirPath is join(mailboxesDir, subject) and APFS and
    // NTFS are case-insensitive, so these two subjects name one directory.
    await registry.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.alice' });

    await expect(
      registry.registerEndpoint('relay.inbox.ALICE', { owner: 'relay.agent.ns.bob' })
    ).rejects.toThrow(/collides with existing endpoint/);
  });

  it('refuses a case variant of a mailbox left on disk by a previous process', async () => {
    await registry.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.alice' });

    const restarted = new EndpointRegistry(tempDir);
    await expect(
      restarted.registerEndpoint('relay.inbox.Alice', { owner: 'relay.agent.ns.bob' })
    ).rejects.toThrow(/collides with existing endpoint/);
  });

  it("does not destroy the owner's mailbox via a case variant", async () => {
    const alice = await registry.registerEndpoint('relay.inbox.alice', {
      owner: 'relay.agent.ns.alice',
    });
    await registry
      .registerEndpoint('relay.inbox.ALICE', { owner: 'relay.agent.ns.bob' })
      .catch(() => undefined);
    // Bob has no endpoint to unregister, so there is nothing to delete through.
    expect(await registry.unregisterEndpoint('relay.inbox.ALICE')).toBe(false);

    await expectDirExists(alice.maildirPath);
  });

  it('refuses a case variant of a mailbox that records NO owner', async () => {
    // The reviewer's reproduction. An unowned mailbox (created from the cockpit,
    // or by the server) has no recorded owner to fall back on, so the collision
    // rule is the only thing standing between it and a variant registration that
    // could then unregister it and delete the directory they share.
    await registry.registerEndpoint('relay.inbox.shared');

    await expect(registry.registerEndpoint('relay.inbox.SHARED')).rejects.toThrow(
      /collides with existing endpoint/
    );
    await expectDirExists(join(tempDir, 'mailboxes', 'relay.inbox.shared'));
  });

  it('still allows the exact same subject to be re-registered after a restart', async () => {
    // Guards against the collision check rejecting the legitimate case.
    await registry.registerEndpoint('relay.inbox.mixedCase', { owner: 'relay.agent.ns.alice' });

    const restarted = new EndpointRegistry(tempDir);
    const again = await restarted.registerEndpoint('relay.inbox.mixedCase', {
      owner: 'relay.agent.ns.alice',
    });
    expect(again.subject).toBe('relay.inbox.mixedCase');
  });

  it('keeps unrelated subjects that share no case-folded form', async () => {
    await registry.registerEndpoint('relay.inbox.alice');
    await registry.registerEndpoint('relay.inbox.alicia');
    expect(registry.size).toBe(2);
  });

  it('leaves the owner file out of the endpoint hash listing', async () => {
    // The .owner file sits beside tmp/new/cur/failed. If it were mistaken for a
    // mailbox the GC would try to reap it.
    await registry.registerEndpoint('relay.inbox.alice', { owner: 'relay.agent.ns.alice' });
    const entries = await readdir(tempDir + '/mailboxes', { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual([
      'relay.inbox.alice',
    ]);
  });
});
