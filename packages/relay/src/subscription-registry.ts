/**
 * Pattern-based pub/sub subscription registry for the Relay message bus.
 *
 * Manages subscriptions where consumers register interest in a subject pattern
 * (which may include `*` and `>` wildcards). When a message arrives, the
 * registry finds all subscriptions whose pattern matches the message subject
 * and returns their handlers.
 *
 * Subscriptions are strictly in-memory: handler functions cannot survive a
 * process restart, so consumers must re-subscribe on startup. (An earlier
 * design persisted patterns to `subscriptions.json` and restored them with
 * no-op handlers — those phantom subscribers claimed and destroyed messages
 * that had no real consumer, so persistence was removed.)
 *
 * @module relay/subscription-registry
 */
import { monotonicFactory } from 'ulidx';
import { validateSubject, matchesPattern } from './subject-matcher.js';
import type { MessageHandler, Unsubscribe, SubscriptionInfo } from './types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/** ULID generator for subscription IDs. Monotonic to guarantee ordering. */
const generateUlid = monotonicFactory();

/** Shape of entries stored in the in-memory subscription map. */
interface SubscriptionEntry {
  pattern: string;
  handler: MessageHandler;
  createdAt: string;
}

/** A message held in the pending buffer awaiting a subscriber. */
interface PendingMessage {
  envelope: RelayEnvelope;
  bufferedAt: number;
}

/** Maximum number of messages to retain per subject in the pending buffer. */
const MAX_PENDING_BUFFER_SIZE = 100;

/** Milliseconds before a buffered message is considered stale and discarded. */
const PENDING_BUFFER_TTL_MS = 30_000;

/**
 * In-memory registry of pattern-based subscriptions.
 *
 * Subscriptions are stored in a `Map<id, SubscriptionEntry>` for efficient
 * lookup and removal. Pattern matching uses the NATS-style `matchesPattern()`
 * from the subject-matcher module.
 */
export class SubscriptionRegistry {
  /** Subscription ID -> entry mapping. */
  private readonly subscriptions = new Map<string, SubscriptionEntry>();

  /** Subject -> pending messages awaiting a subscriber. */
  private readonly pendingBuffers = new Map<string, PendingMessage[]>();

  /** Timer handle for periodic pending buffer cleanup. */
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Subscribe a handler to a subject pattern.
   *
   * The pattern may include NATS-style wildcards (`*` for exactly one token,
   * `>` for one or more remaining tokens). The handler will be invoked for
   * any message whose subject matches the pattern.
   *
   * @param pattern - A subject pattern, possibly with wildcards
   * @param handler - Callback invoked with matching {@link RelayEnvelope} messages
   * @returns An {@link Unsubscribe} function that removes this subscription
   * @throws If the pattern is not a valid subject/pattern string
   */
  subscribe(pattern: string, handler: MessageHandler): Unsubscribe {
    const validation = validateSubject(pattern);
    if (!validation.valid) {
      throw new Error(`Invalid subscription pattern: ${validation.reason.message}`);
    }

    const id = generateUlid();
    const createdAt = new Date().toISOString();

    this.subscriptions.set(id, { pattern, handler, createdAt });

    // Drain any buffered messages whose subject matches this pattern
    this.drainPendingBuffer(pattern, handler);

    return () => {
      this.subscriptions.delete(id);
    };
  }

  /**
   * Buffer a message for a subject that currently has no subscribers.
   *
   * When `publish()` finds no matching subscription handlers and no registered
   * Maildir endpoints, it can call this method to hold the envelope in memory.
   * The next `subscribe()` call whose pattern matches the subject will drain
   * the buffer, delivering any pending messages to the new handler.
   *
   * Buffers are capped at {@link MAX_PENDING_BUFFER_SIZE} messages per subject
   * (oldest dropped when full). Messages older than {@link PENDING_BUFFER_TTL_MS}
   * are discarded during periodic cleanup.
   *
   * @param subject - The concrete subject of the message
   * @param envelope - The message envelope to buffer
   */
  bufferForPendingSubscriber(subject: string, envelope: RelayEnvelope): void {
    let buffer = this.pendingBuffers.get(subject);
    if (!buffer) {
      buffer = [];
      this.pendingBuffers.set(subject, buffer);
    }

    // Evict oldest entry when buffer is full
    if (buffer.length >= MAX_PENDING_BUFFER_SIZE) {
      buffer.shift();
    }

    buffer.push({ envelope, bufferedAt: Date.now() });
  }

  /**
   * Stop the cleanup timer and clear all pending buffers.
   *
   * Should be called alongside `clear()` during shutdown.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.pendingBuffers.clear();
  }

  /**
   * Find all handlers whose subscription pattern matches a concrete subject.
   *
   * Iterates all active subscriptions and uses `matchesPattern()` to test
   * each one against the given subject. Returns an array of matching handlers.
   *
   * @param subject - A concrete (non-wildcard) subject string
   * @returns Array of {@link MessageHandler} functions for matching subscriptions
   */
  getSubscribers(subject: string): MessageHandler[] {
    const handlers: MessageHandler[] = [];

    for (const entry of this.subscriptions.values()) {
      if (matchesPattern(subject, entry.pattern)) {
        handlers.push(entry.handler);
      }
    }

    return handlers;
  }

  /**
   * List all active subscriptions.
   *
   * Returns metadata for each subscription (ID, pattern, creation time).
   * Does not expose handler functions.
   *
   * @returns Array of {@link SubscriptionInfo} for all active subscriptions
   */
  listSubscriptions(): SubscriptionInfo[] {
    const result: SubscriptionInfo[] = [];

    for (const [id, entry] of this.subscriptions.entries()) {
      result.push({
        id,
        pattern: entry.pattern,
        createdAt: entry.createdAt,
      });
    }

    return result;
  }

  /**
   * Get the number of active subscriptions.
   *
   * @returns The count of active subscriptions
   */
  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * Remove all subscriptions.
   *
   * Called during RelayCore shutdown to prevent leaked handlers.
   */
  clear(): void {
    this.subscriptions.clear();
  }

  // ---------------------------------------------------------------------------
  // Pending buffer internals
  // ---------------------------------------------------------------------------

  /**
   * Drain buffered messages for subjects matching `pattern` to `handler`.
   *
   * Called synchronously after a new subscription is registered. Invokes the
   * handler asynchronously (via `Promise.resolve()`) so the subscribe call
   * returns before any buffered messages are delivered.
   */
  private drainPendingBuffer(pattern: string, handler: MessageHandler): void {
    for (const [subject, buffer] of this.pendingBuffers.entries()) {
      if (!matchesPattern(subject, pattern)) continue;

      const messages = buffer.splice(0);
      if (messages.length === 0) continue;

      if (buffer.length === 0) {
        this.pendingBuffers.delete(subject);
      }

      // Deliver asynchronously to avoid blocking the subscribe() caller
      Promise.resolve()
        .then(async () => {
          for (const { envelope } of messages) {
            try {
              await handler(envelope);
            } catch {
              // Handler errors during drain are non-fatal
            }
          }
        })
        .catch(() => undefined);
    }
  }

  /**
   * Start the periodic timer that evicts stale pending-buffer entries.
   *
   * Uses `.unref()` so this timer does not prevent process exit when the
   * registry is used in standalone/test contexts without explicit `shutdown()`.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - PENDING_BUFFER_TTL_MS;
      for (const [subject, buffer] of this.pendingBuffers.entries()) {
        const fresh = buffer.filter((m) => m.bufferedAt >= cutoff);
        if (fresh.length === 0) {
          this.pendingBuffers.delete(subject);
        } else if (fresh.length !== buffer.length) {
          this.pendingBuffers.set(subject, fresh);
        }
      }
    }, PENDING_BUFFER_TTL_MS);
    this.cleanupTimer.unref();
  }
}
