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
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_EVENT_BATCH_MAX,
  TelemetryEventSchema,
  TelemetryEventBatchSchema,
  TelemetryEventInputSchema,
  ExceptionEventSchema,
  type TelemetryEvent,
  type ExceptionEvent,
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
  describe('event names', () => {
    it('are all snake_case [object]_[verb]', () => {
      for (const name of TELEMETRY_EVENT_NAMES) {
        expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      }
    });

    it('has no duplicate names', () => {
      expect(new Set(TELEMETRY_EVENT_NAMES).size).toBe(TELEMETRY_EVENT_NAMES.length);
    });
  });

  describe('TelemetryEventSchema (fully-enveloped)', () => {
    it('accepts a valid app_started event', () => {
      expect(TelemetryEventSchema.safeParse(APP_STARTED).success).toBe(true);
    });

    it('accepts a valid session_created event', () => {
      expect(TelemetryEventSchema.safeParse(SESSION_CREATED).success).toBe(true);
    });

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

    it('rejects an unknown event name', () => {
      const res = TelemetryEventSchema.safeParse({ ...APP_STARTED, event: 'user_identified' });
      expect(res.success).toBe(false);
    });

    it('rejects a non-UUID distinctId', () => {
      const res = TelemetryEventSchema.safeParse({ ...APP_STARTED, distinctId: 'not-a-uuid' });
      expect(res.success).toBe(false);
    });

    it('rejects a non-ISO timestamp', () => {
      const res = TelemetryEventSchema.safeParse({ ...APP_STARTED, timestamp: 'yesterday' });
      expect(res.success).toBe(false);
    });
  });

  describe('TelemetryEventInputSchema (caller-supplied half)', () => {
    it('accepts { event, properties } with no envelope fields', () => {
      const res = TelemetryEventInputSchema.safeParse({
        event: 'session_created',
        properties: { runtime: 'codex' },
      });
      expect(res.success).toBe(true);
    });

    it('rejects envelope fields riding along (strict)', () => {
      const res = TelemetryEventInputSchema.safeParse({
        event: 'session_created',
        properties: { runtime: 'codex' },
        distinctId: VALID_DISTINCT_ID,
      });
      expect(res.success).toBe(false);
    });

    it('rejects unknown property keys', () => {
      const res = TelemetryEventInputSchema.safeParse({
        event: 'session_created',
        properties: { runtime: 'codex', prompt: 'summarize my repo' },
      });
      expect(res.success).toBe(false);
    });
  });

  describe('TelemetryEventBatchSchema', () => {
    it('accepts a batch of valid events', () => {
      const res = TelemetryEventBatchSchema.safeParse({ events: [APP_STARTED, SESSION_CREATED] });
      expect(res.success).toBe(true);
    });

    it('rejects an empty batch', () => {
      expect(TelemetryEventBatchSchema.safeParse({ events: [] }).success).toBe(false);
    });

    it('rejects a batch over the max size', () => {
      const events = Array.from({ length: TELEMETRY_EVENT_BATCH_MAX + 1 }, () => APP_STARTED);
      expect(TelemetryEventBatchSchema.safeParse({ events }).success).toBe(false);
    });

    it('rejects an unknown top-level batch key', () => {
      const res = TelemetryEventBatchSchema.safeParse({ events: [APP_STARTED], api_key: 'phc_x' });
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

    it('accepts a valid $exception event', () => {
      expect(ExceptionEventSchema.safeParse(VALID_EXCEPTION).success).toBe(true);
    });

    it('is NOT accepted by the usage union (kept separate)', () => {
      expect(TelemetryEventSchema.safeParse(VALID_EXCEPTION).success).toBe(false);
    });

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

    it('requires the raw stacktrace type', () => {
      const poisoned = structuredClone(VALID_EXCEPTION);
      (poisoned.properties.$exception_list[0].stacktrace as { type: string }).type = 'resolved';
      expect(ExceptionEventSchema.safeParse(poisoned).success).toBe(false);
    });
  });
});
