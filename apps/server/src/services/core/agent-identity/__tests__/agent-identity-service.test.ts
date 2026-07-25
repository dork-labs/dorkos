import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestDb } from '@dorkos/test-utils/db';
import { agentIdentityTokens, type Db } from '@dorkos/db';
import { AgentIdentityService } from '../agent-identity-service.js';

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

      expect(await service.resolve(first)).toBeUndefined();
      expect(await service.resolve(second)).toBeUndefined();
    });

    it('leaves other agents untouched', async () => {
      const mine = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
      const theirs = await service.mint({ agentPath: '/projects/other', displayName: 'Other' });

      await service.revoke(AGENT_PATH);

      expect(await service.resolve(mine)).toBeUndefined();
      expect(await service.resolve(theirs)).toBeDefined();
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
