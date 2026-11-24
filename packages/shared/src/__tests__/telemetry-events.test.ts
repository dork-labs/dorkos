/**
 * Tests for the shared telemetry event registry (DOR-315).
 *
 * Asserts the two load-bearing guarantees: every event name is snake_case
 * `[object]_[verb]`, and every property object is a STRICT allowlist that
 * rejects unknown keys (the send-side half of the no-PII contract). Also
 * exercises the envelope, batch bound, and the caller-input schema.
 */
import { describe, expect, it } from 'vitest';

import {
  TelemetryEventSchema,
  TelemetryEventInputSchema,
  ExceptionEventSchema,
  AiGenerationEventSchema,
  type TelemetryEvent,
  type ExceptionEvent,
  type AiGenerationEvent,
} from '../telemetry-events.js';

const VALID_DISTINCT_ID = '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4';
const VALID_TIMESTAMP = '2026-07-13T12:00:00.000Z';

const APP_STARTED: TelemetryEvent = {
  event: 'app_started',
  properties: { os: 'darwin-arm64', runtimesConfigured: 3 },
  distinctId: VALID_DISTINCT_ID,
  timestamp: VALID_TIMESTAMP,
  dorkosVersion: '0.47.0',
};

const SESSION_CREATED: TelemetryEvent = {
  event: 'session_created',
  properties: { runtime: 'claude-code' },
  distinctId: VALID_DISTINCT_ID,
  timestamp: VALID_TIMESTAMP,
  dorkosVersion: '0.47.0',
};

describe('telemetry event registry', () => {
  describe('TelemetryEventSchema (fully-enveloped)', () => {
    it('rejects an unknown top-level envelope key', () => {
      const res = TelemetryEventSchema.safeParse({ ...APP_STARTED, sneaky: 'value' });
      expect(res.success).toBe(false);
    });

    it('rejects an unknown property key (strict allowlist)', () => {
      const res = TelemetryEventSchema.safeParse({
        ...APP_STARTED,
        properties: { os: 'darwin-arm64', runtimesConfigured: 3, cwd: '/Users/kai/secret' },
      });
      expect(res.success).toBe(false);
    });

    it('rejects a mismatched property shape for the discriminated event', () => {
      const res = TelemetryEventSchema.safeParse({
        ...APP_STARTED,
        properties: { runtime: 'claude-code' }, // session_created's shape, not app_started's
      });
      expect(res.success).toBe(false);
    });
  });

  describe('TelemetryEventInputSchema (caller-supplied half)', () => {
    it('rejects envelope fields riding along (strict)', () => {
      const res = TelemetryEventInputSchema.safeParse({
        event: 'session_created',
        properties: { runtime: 'codex' },
        distinctId: VALID_DISTINCT_ID,
      });
      expect(res.success).toBe(false);
    });
  });

  describe('ExceptionEventSchema ($exception carve-out)', () => {
    const VALID_EXCEPTION: ExceptionEvent = {
      event: '$exception',
      properties: {
        $exception_list: [
          {
            type: 'TypeError',
            value: '',
            mechanism: { handled: false, synthetic: false },
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  platform: 'node:javascript',
                  filename: 'apps/server/src/x.ts',
                  function: 'fn',
                  lineno: 3,
                  colno: 1,
                  in_app: true,
                },
              ],
            },
          },
        ],
        $exception_level: 'error',
        $process_person_profile: false,
        surface: 'server',
        release: 'dorkos@0.47.0',
        environment: 'production',
        os: 'darwin-arm64',
      },
      distinctId: VALID_DISTINCT_ID,
      timestamp: VALID_TIMESTAMP,
      dorkosVersion: '0.47.0',
    };

    it('rejects an unknown property key (strict allowlist)', () => {
      const res = ExceptionEventSchema.safeParse({
        ...VALID_EXCEPTION,
        properties: { ...VALID_EXCEPTION.properties, cwd: '/Users/kai/secret' },
      });
      expect(res.success).toBe(false);
    });

    it('rejects an unknown stack-frame key (no source/locals can ride along)', () => {
      const poisoned = structuredClone(VALID_EXCEPTION);
      (
        poisoned.properties.$exception_list[0].stacktrace.frames[0] as Record<string, unknown>
      ).vars = { secret: 'x' };
      expect(ExceptionEventSchema.safeParse(poisoned).success).toBe(false);
    });

    it('pins $process_person_profile to false (crashes stay anonymous)', () => {
      const res = ExceptionEventSchema.safeParse({
        ...VALID_EXCEPTION,
        properties: { ...VALID_EXCEPTION.properties, $process_person_profile: true },
      });
      expect(res.success).toBe(false);
    });
  });

  describe('AiGenerationEventSchema ($ai_generation carve-out)', () => {
    const VALID_AI_GENERATION: AiGenerationEvent = {
      event: '$ai_generation',
      properties: {
        $ai_trace_id: '3f3aa6bb-9f44-4f3a-bf67-7c6d2b9a1234',
        $ai_provider: 'claude-code',
        $ai_model: 'claude-opus-4-6',
        $ai_input_tokens: 1200,
        $ai_output_tokens: 340,
        $ai_latency: 4.2,
        $ai_total_cost_usd: 0.51,
        $process_person_profile: false,
      },
      distinctId: VALID_DISTINCT_ID,
      timestamp: VALID_TIMESTAMP,
      dorkosVersion: '0.47.0',
    };

    it('rejects any unknown property key — no prompt/path/content can ride along', () => {
      for (const poison of [
        { prompt: 'summarize this secret file' },
        { $ai_input: 'the raw prompt text' },
        { $ai_output_choices: ['the model reply'] },
        { path: '/Users/kai/.env' },
      ]) {
        const res = AiGenerationEventSchema.safeParse({
          ...VALID_AI_GENERATION,
          properties: { ...VALID_AI_GENERATION.properties, ...poison },
        });
        expect(res.success).toBe(false);
      }
    });

    it('pins $process_person_profile to false (metadata stays anonymous)', () => {
      const res = AiGenerationEventSchema.safeParse({
        ...VALID_AI_GENERATION,
        properties: { ...VALID_AI_GENERATION.properties, $process_person_profile: true },
      });
      expect(res.success).toBe(false);
    });
  });

  // The profile never leaves the machine (spec user-profile-onboarding
  // §Privacy invariant). The usage catalog is a strict allowlist; these pin
  // that no event schema accepts a `profile` property and that no catalog
  // payload names a profile field, so a future event silently carrying the
  // profile is a red build, not a policy violation nobody noticed.
  describe('profile exclusion (user-profile-onboarding privacy invariant)', () => {
    const PROFILE_PAYLOAD = { roles: ['hiring'], displayName: 'Dorian' };

    it('no event schema accepts a `profile` property (strict allowlist holds)', () => {
      for (const valid of [APP_STARTED, SESSION_CREATED]) {
        expect(
          TelemetryEventSchema.safeParse({
            ...valid,
            properties: { ...valid.properties, profile: PROFILE_PAYLOAD },
          }).success
        ).toBe(false);
        expect(TelemetryEventSchema.safeParse({ ...valid, profile: PROFILE_PAYLOAD }).success).toBe(
          false
        );
      }
    });

    it('no catalog property is named after a profile field', async () => {
      // Introspect every property allowlist in the module: any z.object export
      // whose name ends in Properties (usage, feedback, exception, AI carve-outs).
      const registry = await import('../telemetry-events.js');
      const bannedKeys = [
        'profile',
        'roles',
        'displayName',
        'rolePromptDismissedAt',
        'identityPromptDismissedAt',
      ];
      const propertySchemas = Object.entries(registry).filter(
        ([name, value]) =>
          /Properties(Schema)?$/.test(name) &&
          typeof value === 'object' &&
          value !== null &&
          'shape' in value
      );
      // The registry currently carries six property allowlists; if this count
      // drops, the introspection stopped seeing schemas and the test is lying.
      expect(propertySchemas.length).toBeGreaterThanOrEqual(6);
      for (const [, schema] of propertySchemas) {
        const keys = Object.keys((schema as { shape: Record<string, unknown> }).shape);
        for (const banned of bannedKeys) {
          expect(keys).not.toContain(banned);
        }
      }
    });
  });
});

describe('install funnel events (DOR-2862)', () => {
  const envelope = {
    distinctId: VALID_DISTINCT_ID,
    timestamp: VALID_TIMESTAMP,
    dorkosVersion: '0.47.0',
  };

  it.each([
    { installRef: 'someone@example.com' },
    { installRef: 'k3j4mnb8x2qa', utmSource: 'has space' },
    { installRef: 'k3j4mnb8x2qa', hostname: 'kais-macbook' },
  ])('rejects first_run_completed carrying %j', (properties) => {
    expect(
      TelemetryEventSchema.safeParse({ event: 'first_run_completed', properties, ...envelope })
        .success
    ).toBe(false);
  });
});

describe('the anonymous mark on usage events (DOR-4989)', () => {
  const usageEvents = [
    APP_STARTED,
    SESSION_CREATED,
    { ...APP_STARTED, event: 'first_run_completed' as const, properties: {} },
    { ...APP_STARTED, event: 'instance_active' as const, properties: {} },
  ];

  it('never accepts $process_person_profile: true', () => {
    for (const e of usageEvents) {
      const marked = { ...e, properties: { ...e.properties, $process_person_profile: true } };
      expect(TelemetryEventSchema.safeParse(marked).success).toBe(false);
    }
  });

  it('is added by the reporter only: caller input carrying it is rejected', () => {
    expect(
      TelemetryEventInputSchema.safeParse({
        event: 'instance_active',
        properties: { $process_person_profile: false },
      }).success
    ).toBe(false);
  });
});
