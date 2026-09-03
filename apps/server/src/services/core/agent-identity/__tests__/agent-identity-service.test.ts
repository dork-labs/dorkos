import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestDb } from '@dorkos/test-utils/db';
import { agentIdentityTokens, agents, type Db } from '@dorkos/db';
import {
  AgentIdentityService,
  agentTokenDigestPrefix,
  TOKEN_ABSOLUTE_TTL_MS,
  TOKEN_IDLE_TTL_MS,
} from '../agent-identity-service.js';

const AGENT_PATH = '/projects/researcher';

describe('AgentIdentityService', () => {
  let db: Db;
  let service: AgentIdentityService;

  beforeEach(() => {
    db = createTestDb();
    service = new AgentIdentityService(db);
  });

  describe('mint()', () => {
    it('returns a 128-bit token and stores ONLY its sha256 hash', async () => {
      const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

      // 128 bits of randomness, hex-encoded.
      expect(token).toMatch(/^[0-9a-f]{32}$/);

      const rows = db.select().from(agentIdentityTokens).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));

      // The plaintext appears nowhere in the persisted row — the central
      // invariant: a database read can never recover a usable credential.
      expect(JSON.stringify(rows[0])).not.toContain(token);
    });

    it('records the identity fields and defaults the ceiling to destructive', async () => {
      await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

      const [row] = db.select().from(agentIdentityTokens).all();
      expect(row.agentPath).toBe(AGENT_PATH);
      expect(row.displayName).toBe('Researcher');
      // `destructive` = unrestricted, preserving today's trust posture.
      expect(row.tierCeiling).toBe('destructive');
      expect(row.revokedAt).toBeNull();
      expect(row.createdAt).toEqual(expect.any(String));
    });

    it('honors an explicit tier ceiling', async () => {
      await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher', tierCeiling: 'act' });

      const [row] = db.select().from(agentIdentityTokens).all();
      expect(row.tierCeiling).toBe('act');
    });

    it('issues a distinct token on every call', async () => {
      const first = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      const second = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

      expect(first).not.toBe(second);
      expect(db.select().from(agentIdentityTokens).all()).toHaveLength(2);
    });
  });

  describe('resolve()', () => {
    it('resolves a minted token to its identity', async () => {
      const token = await service.mint({
        agentPath: AGENT_PATH,
        displayName: 'Researcher',
        tierCeiling: 'act',
      });

      const identity = await service.resolve(token);

      expect(identity).toEqual({
        agentPath: AGENT_PATH,
        displayName: 'Researcher',
        tierCeiling: 'act',
        createdAt: expect.any(String),
      });
    });

    it('returns undefined for an unknown, empty, or malformed token', async () => {
      await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

      expect(await service.resolve('not-a-real-token')).toBeUndefined();
      expect(await service.resolve('')).toBeUndefined();
    });

    it('does not accept the stored hash itself as a token', async () => {
      const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      const [row] = db.select().from(agentIdentityTokens).all();

      // Someone with database read access holds the hash, not a credential.
      expect(row.tokenHash).not.toBe(token);
      expect(await service.resolve(row.tokenHash)).toBeUndefined();
    });

    it('keeps every concurrently minted token valid', async () => {
      const first = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      const second = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

      // One agent runs many sessions; a new spawn must not log out the others.
      expect(await service.resolve(first)).toBeDefined();
      expect(await service.resolve(second)).toBeDefined();
    });
  });

  describe('revoke()', () => {
    it('revokes every live token for the agent and reports the count', async () => {
      const first = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      const second = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

      expect(await service.revoke(AGENT_PATH)).toBe(2);

      // Marked, not erased (DOR-486). A revoked token used to resolve to
      // `undefined`, which every consumer reads as "unidentified" — and an
      // unidentified caller is capped at the WIDEST tier, so that answer made
      // revoking a capped agent widen it. `inactive` is what each gate fails
      // closed on instead.
      expect(await service.resolve(first)).toMatchObject({ inactive: 'revoked' });
      expect(await service.resolve(second)).toMatchObject({ inactive: 'revoked' });
    });

    it('leaves other agents untouched', async () => {
      const mine = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      const theirs = await service.mint({ agentPath: '/projects/other', displayName: 'Other' });

      await service.revoke(AGENT_PATH);

      expect(await service.resolve(mine)).toMatchObject({ inactive: 'revoked' });
      const other = await service.resolve(theirs);
      expect(other?.agentPath).toBe('/projects/other');
      expect(other?.inactive).toBeUndefined();
    });

    it('marks rows rather than deleting them, so revocation stays auditable', async () => {
      await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      await service.revoke(AGENT_PATH);

      const rows = db.select().from(agentIdentityTokens).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].revokedAt).toEqual(expect.any(String));
    });

    it('is a no-op returning 0 when nothing is live', async () => {
      expect(await service.revoke('/projects/never-minted')).toBe(0);

      await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      await service.revoke(AGENT_PATH);
      // Already-revoked rows do not count toward a second sweep.
      expect(await service.revoke(AGENT_PATH)).toBe(0);
    });
  });
});

/**
 * Token expiry (spec `agent-trust` §3.2, security precondition of tier
 * enforcement). Once tiers are enforced against identity, a token that never
 * expires is a standing credential — so resolution honors two clocks, and the
 * in-session path deliberately honors neither.
 */
describe('AgentIdentityService — token expiry', () => {
  let db: Db;
  let service: AgentIdentityService;

  beforeEach(() => {
    db = createTestDb();
    service = new AgentIdentityService(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Backdate a token's clocks to simulate one minted (and last used) long ago. */
  function backdate(ageMs: number, lastUsedAgeMs = ageMs): void {
    const now = Date.now();
    db.update(agentIdentityTokens)
      .set({
        createdAt: new Date(now - ageMs).toISOString(),
        lastUsedAt: new Date(now - lastUsedAgeMs).toISOString(),
      })
      .run();
  }

  it('resolves a fresh token and records that it was used', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });

    expect(await service.resolve(token)).toMatchObject({ agentPath: AGENT_PATH });

    const [row] = db.select().from(agentIdentityTokens).all();
    expect(row.lastUsedAt).toBeTruthy();
  });

  it('refuses a token that has gone unused for longer than the idle window', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    backdate(TOKEN_IDLE_TTL_MS + 60_000);

    // `expired` rather than `undefined` (DOR-486): an aged-out token must not be
    // a way to SHED a tier ceiling, which resolving to nothing would be. It keeps
    // its recorded ceiling and holds no tool-group grant. It is deliberately not
    // clamped the way `revoked` is — expiry is a clock, not a person saying stop.
    expect(await service.resolve(token)).toMatchObject({ inactive: 'expired' });
  });

  it('refuses a token past the absolute cap even when it is used constantly', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    // Minted long ago, used a minute ago — the idle clock is happy, the hard cap is not.
    backdate(TOKEN_ABSOLUTE_TTL_MS + 60_000, 60_000);

    expect(await service.resolve(token)).toMatchObject({ inactive: 'expired' });
  });

  it('keeps a long-lived token alive while it stays in use', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    backdate(TOKEN_IDLE_TTL_MS * 3, TOKEN_IDLE_TTL_MS - 60_000);

    const identity = await service.resolve(token);
    expect(identity).toMatchObject({ agentPath: AGENT_PATH });
    expect(identity?.inactive).toBeUndefined();
  });

  it('treats a token minted before expiry existed by its mint date', async () => {
    // A legacy row: no `lastUsedAt` at all, minted well before the idle window.
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    db.update(agentIdentityTokens)
      .set({
        createdAt: new Date(Date.now() - TOKEN_IDLE_TTL_MS - 60_000).toISOString(),
        lastUsedAt: null,
      })
      .run();

    expect(await service.resolve(token)).toMatchObject({ inactive: 'expired' });
  });

  it('does not rewrite lastUsedAt on every call', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.resolve(token);
    const [first] = db.select().from(agentIdentityTokens).all();

    await service.resolve(token);
    const [second] = db.select().from(agentIdentityTokens).all();

    // A busy agent must not add a write to every attributed request.
    expect(second.lastUsedAt).toBe(first.lastUsedAt);
  });

  it('still describes an in-session agent whose token aged out', async () => {
    // The in-session path presents no secret, so expiry has nothing to protect
    // against — and dropping the identity would drop the tier ceiling with it.
    await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher', tierCeiling: 'act' });
    backdate(TOKEN_ABSOLUTE_TTL_MS * 2);

    expect(await service.describeAgent(AGENT_PATH)).toMatchObject({ tierCeiling: 'act' });
  });

  it('describes a revoked agent as revoked rather than as nobody', async () => {
    // The in-session half of the same inversion (DOR-486). `undefined` here does
    // not mean "no privilege" to the gate, it means "unidentified" — the widest
    // ceiling there is. Naming the agent AND its state is what lets the gate cap
    // it at `observe` instead of handing it everything.
    await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.revoke(AGENT_PATH);

    expect(await service.describeAgent(AGENT_PATH)).toMatchObject({
      agentPath: AGENT_PATH,
      inactive: 'revoked',
    });
  });

  it('still describes nobody for a path that has never minted a token', async () => {
    expect(await service.describeAgent('/projects/never-minted')).toBeUndefined();
  });
});

/**
 * ADR-0043 licenses the mesh reconciler to delete the `agents` table and rebuild
 * it from `agent.json` files, re-registering every agent under a FRESH ULID. The
 * schema comment argues that keying identity on `agentPath` in its own table
 * survives that; this proves it, rather than trusting the argument.
 */
describe('agent identity tokens survive an ADR-0043 rebuild', () => {
  it('keeps resolving after the agents table is wiped and rebuilt with new ids', async () => {
    const db = createTestDb();
    const service = new AgentIdentityService(db);
    const now = new Date().toISOString();

    /** Register the agent the way the mesh registry does. */
    const register = (id: string) =>
      db
        .insert(agents)
        .values({
          id,
          name: 'researcher',
          displayName: 'Researcher',
          runtime: 'claude-code',
          projectPath: AGENT_PATH,
          registeredAt: now,
          updatedAt: now,
        })
        .run();

    register('01OLDOLDOLDOLDOLDOLDOLDOLD');
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    expect(await service.resolve(token)).toMatchObject({ agentPath: AGENT_PATH });

    // The rebuild: drop the derived cache, rediscover from disk, new ULID.
    db.delete(agents).run();
    register('01NEWNEWNEWNEWNEWNEWNEWNEW');

    // Token material is not derivable from `agent.json`, so it had better still
    // be here — and still point at the same stable filesystem identity.
    expect(db.select().from(agentIdentityTokens).all()).toHaveLength(1);
    expect(await service.resolve(token)).toMatchObject({
      agentPath: AGENT_PATH,
      displayName: 'Researcher',
    });
    expect(await service.describeAgent(AGENT_PATH)).toMatchObject({ agentPath: AGENT_PATH });
  });
});

describe('agentTokenDigestPrefix', () => {
  it('labels a token by digest prefix without ever revealing it', () => {
    const token = 'a'.repeat(32);
    const prefix = agentTokenDigestPrefix(token);

    expect(prefix).toHaveLength(8);
    expect(prefix).toBe(createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8));
    expect(token).not.toContain(prefix);
  });

  it('is stable, so repeat attempts by one token are recognizable', () => {
    expect(agentTokenDigestPrefix('abc')).toBe(agentTokenDigestPrefix('abc'));
    expect(agentTokenDigestPrefix('abc')).not.toBe(agentTokenDigestPrefix('abd'));
  });
});
