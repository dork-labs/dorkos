/** Verified API-key program principals for connector REST and CLI calls. */
import { and, apikey, eq, type Db } from '@dorkos/db';
import type { RequestUser } from '../../core/auth/session-gate.js';
import {
  createServerPrincipal,
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalProof,
} from './server-principal.js';

/** SQLite-backed program-principal mint and live credential validator. */
export class ConnectorProgramPrincipalService {
  private readonly mintedReferenceIds = new WeakMap<object, string>();

  /** Construct the service over Better Auth's canonical API-key table. */
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Mint a process-authentic program principal from one freshly verified API-key user. */
  mint(user: RequestUser, owner: ConnectorOwnerAuthority): ServerPrincipalProof | undefined {
    if (user.credential !== 'api-key' || !user.credentialId) return undefined;
    const row = this.db
      .select({
        id: apikey.id,
        referenceId: apikey.referenceId,
        enabled: apikey.enabled,
        expiresAt: apikey.expiresAt,
      })
      .from(apikey)
      .where(and(eq(apikey.id, user.credentialId), eq(apikey.referenceId, user.userId)))
      .get();
    if (!row || !this.isLive(row)) return undefined;
    const principal = createServerPrincipal({ kind: 'program', owner, credentialId: row.id });
    this.mintedReferenceIds.set(principal, row.referenceId);
    return principal;
  }

  /** Recheck that an already authenticated program principal's API key remains live. */
  revalidate(principal: ServerPrincipalProof): boolean {
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'program') return false;
    const expectedReferenceId = this.mintedReferenceIds.get(principal);
    if (!expectedReferenceId) return false;
    const row = this.db
      .select({
        referenceId: apikey.referenceId,
        enabled: apikey.enabled,
        expiresAt: apikey.expiresAt,
      })
      .from(apikey)
      .where(eq(apikey.id, principal.claims.credentialId))
      .get();
    return Boolean(row && row.referenceId === expectedReferenceId && this.isLive(row));
  }

  private isLive(row: { enabled: boolean | null; expiresAt: Date | null }): boolean {
    return (
      row.enabled === true &&
      (row.expiresAt === null || row.expiresAt.getTime() > this.now().getTime())
    );
  }
}
