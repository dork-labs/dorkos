/**
 * Type consolidation tests — verifies that relay/types.ts re-exports
 * from @dorkos/shared/relay-schemas are structurally compatible and
 * that runtime values satisfy both type definitions.
 *
 * @module relay/__tests__/type-consolidation
 */
import { describe, it, expect } from 'vitest';
import { expectTypeOf } from 'vitest';
import type {
  RateLimitConfig,
  CircuitBreakerConfig,
  BackpressureConfig,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  AdapterConfig,
  AdapterStatus,
} from '../types.js';
import type {
  RateLimitConfig as SharedRateLimitConfig,
  CircuitBreakerConfig as SharedCircuitBreakerConfig,
  BackpressureConfig as SharedBackpressureConfig,
  TelegramAdapterConfig as SharedTelegramAdapterConfig,
  WebhookAdapterConfig as SharedWebhookAdapterConfig,
  AdapterConfig as SharedAdapterConfig,
  AdapterStatus as SharedAdapterStatus,
} from '@dorkos/shared/relay-schemas';

describe('type-consolidation', () => {
  it('relay RateLimitConfig is identical to shared RateLimitConfig', () => {
    const config: RateLimitConfig = {
      enabled: true,
      windowSecs: 60,
      maxPerWindow: 100,
    };
    // Assignable to shared type without casting — proves structural identity
    const shared: SharedRateLimitConfig = config;
    expect(shared.enabled).toBe(true);
    expect(shared.windowSecs).toBe(60);
    expect(shared.maxPerWindow).toBe(100);
    expectTypeOf(config).toMatchTypeOf<SharedRateLimitConfig>();
  });

  it('relay CircuitBreakerConfig is identical to shared CircuitBreakerConfig', () => {
    const config: CircuitBreakerConfig = {
      enabled: true,
      failureThreshold: 5,
      cooldownMs: 30_000,
      halfOpenProbeCount: 1,
      successToClose: 2,
    };
    const shared: SharedCircuitBreakerConfig = config;
    expect(shared.failureThreshold).toBe(5);
    expectTypeOf(config).toMatchTypeOf<SharedCircuitBreakerConfig>();
  });

  it('relay BackpressureConfig is identical to shared BackpressureConfig', () => {
    const config: BackpressureConfig = {
      enabled: true,
      maxMailboxSize: 1000,
      pressureWarningAt: 0.8,
    };
    const shared: SharedBackpressureConfig = config;
    expect(shared.maxMailboxSize).toBe(1000);
    expectTypeOf(config).toMatchTypeOf<SharedBackpressureConfig>();
  });

  it('relay TelegramAdapterConfig is identical to shared TelegramAdapterConfig', () => {
    const config: TelegramAdapterConfig = {
      token: 'bot123:token',
      mode: 'polling',
    };
    const shared: SharedTelegramAdapterConfig = config;
    expect(shared.token).toBe('bot123:token');
    expect(shared.mode).toBe('polling');
    expectTypeOf(config).toMatchTypeOf<SharedTelegramAdapterConfig>();
  });

  it('relay WebhookAdapterConfig is identical to shared WebhookAdapterConfig', () => {
    const config: WebhookAdapterConfig = {
      inbound: { subject: 'relay.human.webhook', secret: 'a'.repeat(16) },
      outbound: { url: 'https://example.com/hook', secret: 'b'.repeat(16) },
    };
    const shared: SharedWebhookAdapterConfig = config;
    expect(shared.inbound.subject).toBe('relay.human.webhook');
    expectTypeOf(config).toMatchTypeOf<SharedWebhookAdapterConfig>();
  });

  it('relay AdapterStatus operational fields are compatible with shared AdapterStatus', () => {
    const status: AdapterStatus = {
      state: 'connected',
      messageCount: { inbound: 5, outbound: 3 },
      errorCount: 0,
    };
    // AdapterStatus in relay is a subset — all its fields exist in shared AdapterStatus
    expectTypeOf(status).toMatchTypeOf<
      Pick<SharedAdapterStatus, 'state' | 'messageCount' | 'errorCount'>
    >();
    expect(status.state).toBe('connected');
    expect(status.messageCount.inbound).toBe(5);
    expect(status.errorCount).toBe(0);
    // Optional fields default to undefined
    expect(status.lastError).toBeUndefined();
    expect(status.startedAt).toBeUndefined();
  });

  it('relay AdapterConfig is identical to shared AdapterConfig', () => {
    const config: AdapterConfig = {
      id: 'test-adapter',
      type: 'telegram',
      enabled: true,
      config: { token: 'bot123:token', mode: 'polling' },
    };
    const shared: SharedAdapterConfig = config;
    expect(shared.id).toBe('test-adapter');
    expect(shared.type).toBe('telegram');
    expectTypeOf(config).toMatchTypeOf<SharedAdapterConfig>();
  });

  it('deprecated Z-suffix types from shared relay-schemas still export valid Zod schemas', async () => {
    const schemas = await import('@dorkos/shared/relay-schemas');
    // Schemas still exist — only the inferred type names changed
    expect(typeof schemas.TelegramAdapterConfigSchema).toBe('object');
    expect(typeof schemas.WebhookAdapterConfigSchema).toBe('object');
    expect(typeof schemas.AdapterConfigSchema).toBe('object');
    expect(typeof schemas.AdapterStatusSchema).toBe('object');
  });

  it('AdapterConfigSchema can parse a valid AdapterConfig value', async () => {
    const { AdapterConfigSchema } = await import('@dorkos/shared/relay-schemas');
    const input: AdapterConfig = {
      id: 'test-adapter',
      type: 'telegram',
      enabled: true,
      config: { token: 'bot123:token', mode: 'polling' },
    };
    const result = AdapterConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('AdapterStatusSchema can parse a valid AdapterStatus value', async () => {
    const { AdapterStatusSchema } = await import('@dorkos/shared/relay-schemas');
    const input = {
      id: 'adapter-1',
      type: 'telegram',
      displayName: 'Telegram',
      state: 'connected',
      messageCount: { inbound: 10, outbound: 5 },
      errorCount: 0,
    };
    const result = AdapterStatusSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
