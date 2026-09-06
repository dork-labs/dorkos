/** Durable, boot-bound runtime principal service for the internal connector listener. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, connectorRuntimeBindings, eq, isNull, type Db } from '@dorkos/db';
import type {
  ConnectorRuntimeBindingBootPort,
  ConnectorRuntimePrincipalPort,
  OpenConnectorTurnInput,
  OpenConnectorTurnResult,
  ResolveConnectorTurnInput,
  ResolveConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../runtime-principal-port.js';
import {
  createServerPrincipal,
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from './server-principal.js';

type RuntimeBindingRow = typeof connectorRuntimeBindings.$inferSelect;

/** Live server authority resolved from canonical runtime context. */
export interface ConnectorRuntimeAuthority {
  /** Owner whose grants may be used during the turn. */
  readonly owner: ConnectorOwnerAuthority;
  /** Stable agent identity bound to the canonical path. */
  readonly agentId: string;
}

/** Canonical identity resolver kept outside runtime-controlled inputs. */
export interface ConnectorRuntimeAuthorityResolver {
  /** Resolve and authorize a new turn from canonical server/runtime state. */
  authorizeTurn(input: OpenConnectorTurnInput): Promise<ConnectorRuntimeAuthority>;
  /** Recheck the exact stored claims before every connector projection call. */
  revalidateTurn(claims: Extract<ServerPrincipalClaims, { kind: 'runtime' }>): Promise<boolean>;
}

/** Typed setup refusal mapped by the runtime boundary without exposing private claims. */
export class ConnectorRuntimeAuthorityError extends Error {
  /** Stable internal refusal code. */
  readonly code: 'boot_not_initialized' | 'authority_refused';

  /**
   * Construct a safe runtime authority error.
   *
   * @param code - Stable setup refusal category.
   * @param message - Secret-free diagnostic.
   */
  constructor(code: ConnectorRuntimeAuthorityError['code'], message: string) {
    super(message);
    this.name = 'ConnectorRuntimeAuthorityError';
    this.code = code;
  }
}

/** Construction options for the durable runtime principal service. */
export interface ConnectorRuntimePrincipalServiceOptions {
  /** Canonical DorkOS database. */
  readonly db: Db;
  /** Resolver that owns canonical runtime/session/agent identity checks. */
  readonly authority: ConnectorRuntimeAuthorityResolver;
  /** Maximum binding lifetime in milliseconds. */
  readonly bindingTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  readonly now?: () => Date;
  /** Injectable process-generation source for deterministic boot tests. */
  readonly makeBootEpoch?: () => string;
  /** Injectable bearer source for deterministic hashing tests. */
  readonly makeBearer?: () => string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function rowOwner(row: {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
}): ConnectorOwnerAuthority {
  return row.ownerKind === 'user'
    ? { kind: 'user', userId: row.ownerId }
    : { kind: 'local_install', installationId: row.ownerId };
}

/** SQLite-backed implementation of the runtime principal and boot-barrier ports. */
export class ConnectorRuntimePrincipalService
  implements ConnectorRuntimePrincipalPort, ConnectorRuntimeBindingBootPort
{
  private readonly db: Db;
  private readonly authority: ConnectorRuntimeAuthorityResolver;
  private readonly bindingTtlMs: number;
  private readonly now: () => Date;
  private readonly makeBootEpoch: () => string;
  private readonly makeBearer: () => string;
  /** Process-local deny fence installed before a durable revoke can fail. */
  private readonly revokedBindingIds = new Set<string>();
  private bootEpoch?: string;

  /**
   * Construct the runtime principal service.
   *
   * @param options - Database, canonical authority resolver, and bounded test seams.
   */
  constructor(options: ConnectorRuntimePrincipalServiceOptions) {
    this.db = options.db;
    this.authority = options.authority;
    this.bindingTtlMs = options.bindingTtlMs ?? 4 * 60 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());
    this.makeBootEpoch = options.makeBootEpoch ?? randomUUID;
    this.makeBearer = options.makeBearer ?? (() => randomBytes(32).toString('base64url'));
  }

  /** Revoke every prior-process binding and establish the current boot epoch. */
  async initializeBoot(): Promise<{ readonly bootEpoch: string }> {
    const now = this.now().toISOString();
    const bootEpoch = this.makeBootEpoch();
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: now, revokeReason: 'server_restart' })
      .where(isNull(connectorRuntimeBindings.revokedAt))
      .run();
    this.revokedBindingIds.clear();
    this.bootEpoch = bootEpoch;
    return Promise.resolve({ bootEpoch });
  }

  /** Open one bearer after resolving live canonical runtime authority. */
  async openTurn(input: OpenConnectorTurnInput): Promise<OpenConnectorTurnResult> {
    input.signal.throwIfAborted();
    const bootEpoch = this.requireBootEpoch();
    let resolved: ConnectorRuntimeAuthority;
    try {
      resolved = await this.authority.authorizeTurn(input);
    } catch {
      input.signal.throwIfAborted();
      throw new ConnectorRuntimeAuthorityError(
        'authority_refused',
        'Canonical runtime authority could not be verified.'
      );
    }
    input.signal.throwIfAborted();

    const bindingId = randomUUID();
    const bearer = this.makeBearer();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.bindingTtlMs);
    this.db
      .insert(connectorRuntimeBindings)
      .values({
        id: bindingId,
        tokenHash: tokenHash(bearer),
        bootEpoch,
        ...ownerColumns(resolved.owner),
        runtime: input.runtime,
        canonicalSessionId: input.canonicalSessionId,
        agentId: resolved.agentId,
        agentPath: input.agentPath,
        canonicalCwd: input.canonicalCwd,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })
      .run();
    return { bindingId, bearer, expiresAt: expiresAt.toISOString() };
  }

  /** Resolve a bearer against current process, context, expiry, and live authority. */
  async resolve(input: ResolveConnectorTurnInput): Promise<ResolveConnectorTurnResult> {
    const row = this.db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.tokenHash, tokenHash(input.bearer)))
      .get();
    if (!row) return { status: 'refused', reason: 'invalid' };
    const initialRefusal = this.bindingRefusal(row);
    if (initialRefusal) return { status: 'refused', reason: initialRefusal };
    if (row.runtime !== input.expectedRuntime) {
      return { status: 'refused', reason: 'wrong_runtime' };
    }
    if ((row.canonicalCwd ?? undefined) !== input.expectedCanonicalCwd) {
      return { status: 'refused', reason: 'wrong_cwd' };
    }

    const claims = {
      kind: 'runtime',
      owner: rowOwner(row),
      bindingId: row.id,
      runtime: row.runtime,
      canonicalSessionId: row.canonicalSessionId,
      agentId: row.agentId,
      agentPath: row.agentPath,
      ...(row.canonicalCwd && { canonicalCwd: row.canonicalCwd }),
    } as const;
    if (!(await this.authority.revalidateTurn(claims))) {
      this.revokedBindingIds.add(row.id);
      this.db
        .update(connectorRuntimeBindings)
        .set({ revokedAt: this.now().toISOString(), revokeReason: 'authority_changed' })
        .where(
          and(eq(connectorRuntimeBindings.id, row.id), isNull(connectorRuntimeBindings.revokedAt))
        )
        .run();
      return { status: 'refused', reason: 'authority_changed' };
    }
    const current = this.bindingRow(row.id);
    if (!current) return { status: 'refused', reason: 'invalid' };
    const currentRefusal = this.bindingRefusal(current);
    if (currentRefusal) return { status: 'refused', reason: currentRefusal };
    if (!this.sameBinding(row, current)) {
      return { status: 'refused', reason: 'authority_changed' };
    }
    return { status: 'resolved', principal: createServerPrincipal(claims) };
  }

  /** Recheck an already authenticated runtime principal before another provider attempt. */
  async revalidatePrincipal(principal: ServerPrincipalProof): Promise<boolean> {
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') return false;
    const claims = principal.claims;
    if (this.revokedBindingIds.has(claims.bindingId)) return false;
    const row = this.db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.id, claims.bindingId))
      .get();
    if (
      !row ||
      !this.bootEpoch ||
      row.bootEpoch !== this.bootEpoch ||
      row.revokedAt ||
      Date.parse(row.expiresAt) <= this.now().getTime() ||
      row.runtime !== claims.runtime ||
      row.canonicalSessionId !== claims.canonicalSessionId ||
      row.agentId !== claims.agentId ||
      row.agentPath !== claims.agentPath ||
      (row.canonicalCwd ?? undefined) !== claims.canonicalCwd ||
      row.ownerKind !== claims.owner.kind ||
      row.ownerId !== ownerColumns(claims.owner).ownerId
    ) {
      return false;
    }
    if (await this.authority.revalidateTurn(claims)) {
      const current = this.bindingRow(claims.bindingId);
      return Boolean(
        current && !this.bindingRefusal(current) && this.bindingMatchesPrincipal(current, claims)
      );
    }
    this.revokedBindingIds.add(row.id);
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: this.now().toISOString(), revokeReason: 'authority_changed' })
      .where(
        and(eq(connectorRuntimeBindings.id, row.id), isNull(connectorRuntimeBindings.revokedAt))
      )
      .run();
    return false;
  }

  /** Revoke one binding on a terminal, cancelled, setup-failed, or runtime-failed path. */
  async revoke(bindingId: string, reason: RevokeConnectorTurnReason): Promise<void> {
    this.revokedBindingIds.add(bindingId);
    this.db
      .update(connectorRuntimeBindings)
      .set({ revokedAt: this.now().toISOString(), revokeReason: reason })
      .where(
        and(eq(connectorRuntimeBindings.id, bindingId), isNull(connectorRuntimeBindings.revokedAt))
      )
      .run();
  }

  private bindingRow(bindingId: string): RuntimeBindingRow | undefined {
    return this.db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.id, bindingId))
      .get();
  }

  private bindingRefusal(row: RuntimeBindingRow): 'revoked' | 'stale_boot' | 'expired' | undefined {
    if (!this.bootEpoch || row.bootEpoch !== this.bootEpoch) return 'stale_boot';
    if (this.revokedBindingIds.has(row.id) || row.revokedAt) return 'revoked';
    if (Date.parse(row.expiresAt) <= this.now().getTime()) return 'expired';
    return undefined;
  }

  private sameBinding(left: RuntimeBindingRow, right: RuntimeBindingRow): boolean {
    return (
      left.tokenHash === right.tokenHash &&
      left.bootEpoch === right.bootEpoch &&
      left.ownerKind === right.ownerKind &&
      left.ownerId === right.ownerId &&
      left.runtime === right.runtime &&
      left.canonicalSessionId === right.canonicalSessionId &&
      left.agentId === right.agentId &&
      left.agentPath === right.agentPath &&
      left.canonicalCwd === right.canonicalCwd
    );
  }

  private bindingMatchesPrincipal(
    row: RuntimeBindingRow,
    claims: Extract<ServerPrincipalClaims, { kind: 'runtime' }>
  ): boolean {
    return (
      row.runtime === claims.runtime &&
      row.canonicalSessionId === claims.canonicalSessionId &&
      row.agentId === claims.agentId &&
      row.agentPath === claims.agentPath &&
      (row.canonicalCwd ?? undefined) === claims.canonicalCwd &&
      row.ownerKind === claims.owner.kind &&
      row.ownerId === ownerColumns(claims.owner).ownerId
    );
  }

  private requireBootEpoch(): string {
    if (!this.bootEpoch) {
      throw new ConnectorRuntimeAuthorityError(
        'boot_not_initialized',
        'Runtime connector authority is unavailable before boot initialization.'
      );
    }
    return this.bootEpoch;
  }
}
