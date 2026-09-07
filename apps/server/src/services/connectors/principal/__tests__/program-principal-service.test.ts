/** Better Auth API-key liveness for connector program principals. */
import { beforeEach, describe, expect, it } from 'vitest';
import { apikey, createDb, eq, runMigrations, type Db } from '@dorkos/db';
import { isServerPrincipal } from '../server-principal.js';
import { ConnectorProgramPrincipalService } from '../program-principal-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-09-06T12:00:00.000Z');

describe('ConnectorProgramPrincipalService', () => {
  let db: Db;
  let service: ConnectorProgramPrincipalService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    db.insert(apikey)
      .values({
        id: 'credential-a',
        referenceId: 'user-a',
        key: 'stored-hash',
        enabled: true,
        expiresAt: new Date(NOW.getTime() + 60_000),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    service = new ConnectorProgramPrincipalService(db, () => NOW);
  });

  it('mints only from the exact live verified API-key record', () => {
    const principal = service.mint(
      { userId: 'user-a', credential: 'api-key', credentialId: 'credential-a' },
      OWNER
    );
    expect(isServerPrincipal(principal)).toBe(true);
    expect(principal?.claims).toEqual({
      kind: 'program',
      owner: OWNER,
      credentialId: 'credential-a',
    });
    expect(
      service.mint(
        { userId: 'foreign-user', credential: 'api-key', credentialId: 'credential-a' },
        OWNER
      )
    ).toBeUndefined();
    expect(service.mint({ userId: 'user-a', credential: 'cookie' }, OWNER)).toBeUndefined();
  });

  it('denies the existing process principal immediately after revoke or expiry', () => {
    const principal = service.mint(
      { userId: 'user-a', credential: 'api-key', credentialId: 'credential-a' },
      OWNER
    )!;
    expect(service.revalidate(principal)).toBe(true);
    db.update(apikey).set({ enabled: false }).where(eq(apikey.id, 'credential-a')).run();
    expect(service.revalidate(principal)).toBe(false);

    db.update(apikey)
      .set({ enabled: true, expiresAt: new Date(NOW.getTime() - 1) })
      .where(eq(apikey.id, 'credential-a'))
      .run();
    expect(service.revalidate(principal)).toBe(false);
  });

  it('denies a minted principal if the credential is reassigned to another user', () => {
    const principal = service.mint(
      { userId: 'user-a', credential: 'api-key', credentialId: 'credential-a' },
      OWNER
    )!;
    db.update(apikey).set({ referenceId: 'user-b' }).where(eq(apikey.id, 'credential-a')).run();

    expect(service.revalidate(principal)).toBe(false);
  });
});
