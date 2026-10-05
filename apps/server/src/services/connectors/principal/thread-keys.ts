/**
 * Thread keys: the bearer a long-lived Codex app-server process holds for one
 * loaded thread (ADR 261005-113107, spec `codex-app-server-transport` §9).
 *
 * ## Why they exist
 *
 * `codex app-server` fixes a thread's config when it loads the thread and
 * silently ignores new config afterwards, so the per-turn bearer exec passes
 * in the environment cannot reach a loaded thread. Instead DorkOS mints one
 * key per loaded thread and sends it once, as a literal header, in the
 * thread's config. On its own the key authorizes NOTHING: each DorkOS turn
 * attaches its own turn binding (the one `openTurn` returned) and detaches it
 * when the turn ends, and the listener resolves the key to whichever binding is
 * attached right now — then runs every check a turn bearer gets. No attached
 * binding, the same refusal as an expired bearer. So the authority a key
 * carries is exactly the open turn's, and a call outside a turn (a background
 * command poking the URL, a late call) is refused.
 *
 * ## Custody
 *
 * - 256 random bits, `dtk_`-prefixed so the listener can tell it from a turn
 *   bearer without a lookup.
 * - Held in memory only, by its SHA-256, never persisted.
 * - Never logged: the log carries the non-secret `keyId`.
 * - Revoked when its thread unloads, when its process exits or is reaped, and
 *   at shutdown.
 *
 * @module services/connectors/principal/thread-keys
 */
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../../../lib/logger.js';
import type {
  ConnectorThreadKeyPort,
  ConnectorThreadKeyScope,
  MintedConnectorThreadKey,
  RevokeConnectorThreadKeyReason,
} from '../runtime-principal-port.js';

/** Prefix that marks a bearer as a thread key rather than a turn bearer. */
export const THREAD_KEY_PREFIX = 'dtk_';

/** Random bytes in one key: 256 bits. */
const THREAD_KEY_BYTES = 32;

interface ThreadKeyEntry {
  readonly keyId: string;
  readonly scope: ConnectorThreadKeyScope;
  /** The open turn's binding, while one is attached. */
  attachedBindingId: string | undefined;
}

/** What a thread key resolves to: its scope, and the open turn's binding if any. */
export interface ResolvedThreadKey {
  /** Non-secret identifier, for logs. */
  readonly keyId: string;
  /** What the key may ever stand for. */
  readonly scope: ConnectorThreadKeyScope;
  /** The attached turn binding, or `undefined` between turns. */
  readonly bindingId: string | undefined;
}

/** Listener-side half of the registry: tell a thread key apart and look it up. */
export interface ConnectorThreadKeyResolver {
  /** Whether a bearer is shaped like a thread key (no lookup). */
  isThreadKey(bearer: string): boolean;
  /** Look a live key up, or `undefined` when unknown or revoked. */
  lookup(bearer: string): ResolvedThreadKey | undefined;
}

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Construction seams for {@link ConnectorThreadKeyRegistry}. */
export interface ConnectorThreadKeyRegistryOptions {
  /** Random source; tests make it deterministic. */
  readonly randomBytes?: (size: number) => Buffer;
}

/** In-memory registry implementing both halves of the thread-key contract. */
export class ConnectorThreadKeyRegistry
  implements ConnectorThreadKeyPort, ConnectorThreadKeyResolver
{
  private readonly byHash = new Map<string, ThreadKeyEntry>();
  private readonly hashById = new Map<string, string>();
  private readonly random: (size: number) => Buffer;

  /**
   * Construct an empty registry.
   *
   * @param options - Test seams.
   */
  constructor(options: ConnectorThreadKeyRegistryOptions = {}) {
    this.random = options.randomBytes ?? randomBytes;
  }

  /** Mint a 256-bit key bound to one scope. */
  mint(scope: ConnectorThreadKeyScope): MintedConnectorThreadKey {
    const key = `${THREAD_KEY_PREFIX}${this.random(THREAD_KEY_BYTES).toString('base64url')}`;
    const keyId = this.random(8).toString('hex');
    const hash = hashOf(key);
    this.byHash.set(hash, { keyId, scope, attachedBindingId: undefined });
    this.hashById.set(keyId, hash);
    logger.debug('[ThreadKeys] minted', {
      keyId,
      runtime: scope.runtime,
      sessionId: scope.canonicalSessionId,
    });
    return { keyId, key };
  }

  /** Attach the open turn's binding; throws for an unknown, foreign or busy key. */
  attach(keyId: string, binding: { bindingId: string; canonicalSessionId: string }): void {
    const entry = this.entryById(keyId);
    if (!entry) throw new Error(`Thread key ${keyId} is not live.`);
    if (entry.scope.canonicalSessionId !== binding.canonicalSessionId) {
      throw new Error(`Thread key ${keyId} belongs to another session.`);
    }
    if (entry.attachedBindingId !== undefined && entry.attachedBindingId !== binding.bindingId) {
      throw new Error(`Thread key ${keyId} is still attached to another turn.`);
    }
    entry.attachedBindingId = binding.bindingId;
  }

  /** Detach a binding; a no-op unless that exact binding is attached. */
  detach(keyId: string, bindingId: string): void {
    const entry = this.entryById(keyId);
    if (entry?.attachedBindingId === bindingId) entry.attachedBindingId = undefined;
  }

  /** Revoke one key for good. Idempotent. */
  revoke(keyId: string, reason: RevokeConnectorThreadKeyReason): void {
    const hash = this.hashById.get(keyId);
    if (hash === undefined) return;
    this.hashById.delete(keyId);
    this.byHash.delete(hash);
    logger.debug('[ThreadKeys] revoked', { keyId, reason });
  }

  /** Revoke every key minted for one runtime process. Idempotent. */
  revokeProcess(processKey: string, reason: RevokeConnectorThreadKeyReason): void {
    for (const entry of [...this.byHash.values()]) {
      if (entry.scope.processKey === processKey) this.revoke(entry.keyId, reason);
    }
  }

  /** Whether a bearer is shaped like a thread key (no lookup). */
  isThreadKey(bearer: string): boolean {
    return bearer.startsWith(THREAD_KEY_PREFIX);
  }

  /** Look a live key up, or `undefined` when unknown or revoked. */
  lookup(bearer: string): ResolvedThreadKey | undefined {
    if (!this.isThreadKey(bearer)) return undefined;
    const entry = this.byHash.get(hashOf(bearer));
    if (!entry) return undefined;
    return { keyId: entry.keyId, scope: entry.scope, bindingId: entry.attachedBindingId };
  }

  /** How many keys are live; diagnostics and tests. */
  get size(): number {
    return this.byHash.size;
  }

  private entryById(keyId: string): ThreadKeyEntry | undefined {
    const hash = this.hashById.get(keyId);
    return hash === undefined ? undefined : this.byHash.get(hash);
  }
}

/** The process-wide registry the composition root wires into the listener and runtimes. */
export const connectorThreadKeys = new ConnectorThreadKeyRegistry();
