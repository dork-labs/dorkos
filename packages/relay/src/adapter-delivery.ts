/**
 * Adapter delivery module for the Relay message bus.
 *
 * Routes messages to external channel adapters (Telegram, webhooks, etc.)
 * with timeout protection, SQLite audit-trail indexing, and error handling.
 *
 * @module relay/adapter-delivery
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { hashSubject } from './endpoint-registry.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { AdapterRegistryLike, AdapterContext, DeliveryResult } from './types.js';

/** Logger interface for adapter delivery warnings. */
interface Logger {
  warn: (...args: unknown[]) => void;
}

/**
 * Delivers messages to matching adapters with timeout protection
 * and SQLite audit-trail indexing.
 */
export class AdapterDelivery {
  /** Adapter delivery timeout in milliseconds. */
  static readonly TIMEOUT_MS = 30_000;

  constructor(
    private readonly adapterRegistry: AdapterRegistryLike | undefined,
    private readonly sqliteIndex: SqliteIndex,
    private readonly logger: Logger = console,
  ) {}

  /**
   * Deliver a message to a matching adapter with timeout protection.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param contextBuilder - Optional callback to build adapter context
   * @returns DeliveryResult or null if no adapter registry configured
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    contextBuilder?: (subject: string) => AdapterContext | undefined,
  ): Promise<DeliveryResult | null> {
    if (!this.adapterRegistry) return null;

    const context = contextBuilder?.(subject);

    let timer: NodeJS.Timeout;
    try {
      const deliveryPromise = this.adapterRegistry.deliver(subject, envelope, context);

      const result = await Promise.race([
        deliveryPromise,
        new Promise<DeliveryResult>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('adapter delivery timeout (30s)')),
            AdapterDelivery.TIMEOUT_MS,
          );
        }),
      ]);

      // Index adapter-delivered messages in SQLite for audit trail
      if (result && result.success) {
        const subjectHash = hashSubject(subject);
        this.sqliteIndex.insertMessage({
          id: envelope.id,
          subject,
          endpointHash: `adapter:${subjectHash}`,
          status: 'delivered',
          createdAt: envelope.createdAt,
          expiresAt: null,
        });
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('RelayCore: adapter delivery failed:', errorMessage);
      return {
        success: false,
        error: errorMessage,
        deadLettered: false,
        durationMs: undefined,
      };
    } finally {
      clearTimeout(timer!);
    }
  }
}
