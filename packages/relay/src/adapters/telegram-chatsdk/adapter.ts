/**
 * Chat SDK-backed Telegram adapter for the Relay message bus.
 *
 * Uses the `chat` package and `@chat-adapter/telegram` to receive messages
 * via long-polling or webhooks, and to deliver messages back to Telegram
 * chats. Extends {@link BaseRelayAdapter} for lifecycle and status management.
 *
 * @module relay/adapters/telegram-chatsdk/adapter
 */
import { Chat } from 'chat';
import type { StateAdapter, Lock, Thread, Message } from 'chat';
import {
  TelegramAdapter as ChatSdkTelegramAdapterImpl,
  createTelegramAdapter,
} from '@chat-adapter/telegram';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type { RelayPublisher, AdapterContext, DeliveryResult } from '../../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { handleInboundMessage } from './inbound.js';
import { deliverMessage, deliverStream as deliverStreamMsg } from './outbound.js';
import type { ResponseBuffer } from './outbound.js';
import { ChatSdkTelegramThreadIdCodec } from '../../lib/thread-id.js';

/** Configuration for the Chat SDK Telegram adapter. */
export interface ChatSdkTelegramAdapterConfig {
  /** Bot token from @BotFather. */
  token: string;
  /** Connection mode. Defaults to 'polling'. */
  mode?: 'polling' | 'webhook';
  /** Bot username override (optional). */
  userName?: string;
}

/**
 * Minimal in-memory StateAdapter implementation.
 *
 * The Chat SDK requires a StateAdapter for deduplication and thread locking.
 * This implementation satisfies the interface using plain Maps without any
 * external dependencies. Not suitable for multi-instance deployments — use
 * a Redis-backed adapter in production clusters.
 */
class MemoryStateAdapter implements StateAdapter {
  private readonly store = new Map<string, { value: unknown; expiresAt?: number }>();
  private readonly locks = new Map<string, Lock>();
  private readonly lists = new Map<string, unknown[]>();
  private readonly subscriptions = new Set<string>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.lists.delete(key);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const existing = this.locks.get(threadId);
    if (existing && Date.now() < existing.expiresAt) return null;

    const lock: Lock = {
      threadId,
      token: Math.random().toString(36).slice(2),
      expiresAt: Date.now() + ttlMs,
    };
    this.locks.set(threadId, lock);
    return lock;
  }

  async releaseLock(lock: Lock): Promise<void> {
    const current = this.locks.get(lock.threadId);
    if (current?.token === lock.token) {
      this.locks.delete(lock.threadId);
    }
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const current = this.locks.get(lock.threadId);
    if (current?.token !== lock.token) return false;
    current.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.locks.delete(threadId);
  }

  async subscribe(threadId: string): Promise<void> {
    this.subscriptions.add(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.subscriptions.delete(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.subscriptions.has(threadId);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    if (options?.maxLength !== undefined && list.length > options.maxLength) {
      list.splice(0, list.length - options.maxLength);
    }
    this.lists.set(key, list);
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return (this.lists.get(key) ?? []) as T[];
  }
}

/**
 * Chat SDK Telegram adapter for the Relay message bus.
 *
 * Extends {@link BaseRelayAdapter} to bridge Telegram chats into the Relay
 * subject hierarchy via the `chat` + `@chat-adapter/telegram` packages.
 * Delegates message parsing to the inbound sub-module and delivery to the
 * outbound sub-module.
 */
export class ChatSdkTelegramAdapter extends BaseRelayAdapter {
  private readonly config: ChatSdkTelegramAdapterConfig;
  private readonly codec: ChatSdkTelegramThreadIdCodec;
  /** Per-chat response buffers for StreamEvent accumulation. */
  private readonly responseBuffers = new Map<string, ResponseBuffer>();
  private chat: Chat | null = null;
  /** Underlying Chat SDK TelegramAdapter, stored separately for direct postMessage access. */
  private telegramAdapter: ChatSdkTelegramAdapterImpl | null = null;

  constructor(
    id: string,
    config: ChatSdkTelegramAdapterConfig,
    displayName = 'Telegram (Chat SDK)'
  ) {
    const codec = new ChatSdkTelegramThreadIdCodec(id);
    super(id, codec.prefix, displayName);
    this.codec = codec;
    this.config = config;
  }

  /**
   * Connect to Telegram via the Chat SDK and register inbound message handlers.
   *
   * Creates a Chat instance with a MemoryStateAdapter and TelegramAdapter,
   * registers handlers for all inbound messages, then starts polling.
   *
   * @param relay - The RelayPublisher to publish inbound messages to
   */
  protected async _start(relay: RelayPublisher): Promise<void> {
    const botUserName = this.config.userName ?? 'dorkos_bot';

    const telegramAdapter = createTelegramAdapter({
      botToken: this.config.token,
      mode: this.config.mode === 'webhook' ? 'webhook' : 'polling',
    });

    const state = new MemoryStateAdapter();
    await state.connect();

    const chat = new Chat({
      userName: botUserName,
      adapters: { telegram: telegramAdapter },
      state,
      logger: 'silent',
    });

    // Register handlers for both direct messages and all messages (covers DMs + groups)
    chat.onDirectMessage(async (thread: Thread, message: Message) => {
      // Echo prevention: skip messages from our own bot subject prefix
      if (this.isOwnEcho(message)) return;
      await handleInboundMessage(
        thread,
        message,
        relay,
        this.makeInboundCallbacks(),
        this.logger,
        this.codec
      );
    });

    chat.onNewMention(async (thread: Thread, message: Message) => {
      if (this.isOwnEcho(message)) return;
      await handleInboundMessage(
        thread,
        message,
        relay,
        this.makeInboundCallbacks(),
        this.logger,
        this.codec
      );
    });

    chat.onSubscribedMessage(async (thread: Thread, message: Message) => {
      if (this.isOwnEcho(message)) return;
      await handleInboundMessage(
        thread,
        message,
        relay,
        this.makeInboundCallbacks(),
        this.logger,
        this.codec
      );
    });

    // Initialize chat (starts polling or registers webhook handler)
    await chat.initialize();

    this.chat = chat;
    this.telegramAdapter = telegramAdapter;
    this.logger.info('[TelegramChatSdk] started', { mode: this.config.mode ?? 'polling' });
  }

  /**
   * Disconnect from Telegram and clean up resources.
   *
   * Shuts down the Chat SDK instance and nulls internal references.
   */
  protected async _stop(): Promise<void> {
    if (this.chat) {
      try {
        await this.chat.shutdown();
      } catch {
        // best-effort — chat may already be stopped
      }
      this.chat = null;
      this.telegramAdapter = null;
    }
    this.responseBuffers.clear();
  }

  /**
   * Deliver a Relay message to Telegram.
   *
   * Delegates to the outbound module. Skips delivery when the envelope
   * originates from this adapter's own subject prefix to prevent echo loops.
   *
   * @param subject - The target relay subject
   * @param envelope - The relay envelope to deliver
   * @param _context - Unused adapter context
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    // Echo prevention: skip messages published by this adapter
    if (envelope.from?.startsWith(this.codec.prefix)) {
      return { success: true };
    }

    return deliverMessage(
      subject,
      envelope,
      this.telegramAdapter,
      this.responseBuffers,
      this.makeOutboundCallbacks(),
      this.logger,
      this.codec
    );
  }

  /**
   * Deliver a streaming response to Telegram incrementally.
   *
   * Delegates to the outbound module's deliverStream helper which uses
   * the Chat SDK adapter's native stream() method when available.
   *
   * @param subject - The target relay subject
   * @param _threadId - Unused (subject encodes the thread ID)
   * @param stream - Async iterable of text chunks
   * @param _context - Unused adapter context
   */
  async deliverStream(
    subject: string,
    _threadId: string,
    stream: AsyncIterable<string>,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    return deliverStreamMsg(
      subject,
      stream,
      this.telegramAdapter,
      this.makeOutboundCallbacks(),
      this.logger,
      this.codec
    );
  }

  /**
   * Validate the bot token without starting polling or webhook.
   *
   * Creates a temporary TelegramAdapter and calls initialize to verify
   * credentials are valid before committing to a full start.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
    try {
      const testAdapter = createTelegramAdapter({
        botToken: this.config.token,
        mode: 'polling',
      });
      const state = new MemoryStateAdapter();
      await state.connect();
      const testChat = new Chat({
        userName: 'test',
        adapters: { telegram: testAdapter },
        state,
        logger: 'silent',
      });
      await testChat.initialize();
      const botUsername = testAdapter.userName;
      await testChat.shutdown();
      return { ok: true, botUsername };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Check whether an inbound message was sent by the bot itself.
   *
   * The Chat SDK TelegramAdapter marks bot messages with `author.isMe === true`.
   *
   * @param message - The inbound Chat SDK message to inspect
   */
  private isOwnEcho(message: Message): boolean {
    return message.author.isMe === true;
  }
}
