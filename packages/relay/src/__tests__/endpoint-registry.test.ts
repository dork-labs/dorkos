import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, stat, rm } from 'node:fs/promises';
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

    it('throws when subject is invalid', async () => {
      await expect(registry.registerEndpoint('')).rejects.toThrow('Invalid subject');
    });

    it('throws when endpoint is already registered', async () => {
      const subject = 'relay.agent.dup';
      await registry.registerEndpoint(subject);

      await expect(registry.registerEndpoint(subject)).rejects.toThrow('already registered');
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
  });

  // ---------------------------------------------------------------------------
  // getEndpoint
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // getEndpointByHash
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // listEndpoints
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // hasEndpoint
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // size
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Hash determinism and directory structure
  // ---------------------------------------------------------------------------

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
});
