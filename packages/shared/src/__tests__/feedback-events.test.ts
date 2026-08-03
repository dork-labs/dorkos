/**
 * Tests for the FEEDBACK section of the shared telemetry event registry
 * (DOR-317, ADR 260713-143958 Phase 5).
 *
 * Asserts the load-bearing split: feedback events carry the ONLY free-text this
 * registry permits (`message`/`contact` are user-volunteered), while the usage
 * catalog stays allowlist-only. Also exercises `buildFeedbackEvent`'s kind→event
 * mapping, the submission schema, and the envelope bounds.
 */
import { describe, expect, it } from 'vitest';

import {
  FeedbackEventSchema,
  FeedbackSubmissionSchema,
  FeedbackDiagnosticsSchema,
  BreadcrumbSchema,
  FeedbackSubmittedProperties,
  FeatureRequestedProperties,
  buildFeedbackEvent,
  FEEDBACK_EVENT_NAMES,
  MAX_FEEDBACK_MESSAGE_LEN,
  MAX_BREADCRUMBS,
  MAX_TRANSCRIPT_LEN,
  MAX_LOG_EXCERPT_LEN,
  TelemetryEventInputSchema,
} from '../telemetry-events.js';

const VALID_DISTINCT_ID = '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4';
const VALID_TIMESTAMP = '2026-07-13T12:00:00.000Z';

const FEEDBACK_SUBMITTED = {
  event: 'feedback_submitted' as const,
  properties: {
    kind: 'bug' as const,
    message: 'The sidebar flickers when I switch sessions.',
    contact: 'kai@example.com',
    surface: 'cockpit' as const,
    route: '/agents',
    dorkosVersion: '0.47.0',
  },
  distinctId: VALID_DISTINCT_ID,
  timestamp: VALID_TIMESTAMP,
};

const FEATURE_REQUESTED = {
  event: 'feature_requested' as const,
  properties: {
    message: 'Please add a keyboard shortcut for the command palette.',
    surface: 'site' as const,
  },
  distinctId: 'ph_visitor_abc123',
  timestamp: VALID_TIMESTAMP,
};

describe('feedback event registry', () => {
  describe('event names', () => {
    it('are all snake_case [object]_[verb]', () => {
      for (const name of FEEDBACK_EVENT_NAMES) {
        expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      }
    });
  });

  describe('FeedbackEventSchema', () => {
    it('accepts a valid feedback_submitted event', () => {
      expect(FeedbackEventSchema.safeParse(FEEDBACK_SUBMITTED).success).toBe(true);
    });

    it('accepts a valid feature_requested event', () => {
      expect(FeedbackEventSchema.safeParse(FEATURE_REQUESTED).success).toBe(true);
    });

    it('accepts free-text message and contact (the volunteered-content exemption)', () => {
      const res = FeedbackEventSchema.safeParse({
        ...FEEDBACK_SUBMITTED,
        properties: {
          ...FEEDBACK_SUBMITTED.properties,
          message: 'Anything the user typed: a path /Users/kai, an email a@b.com, a URL.',
          contact: 'find me @kai on the forum',
        },
      });
      expect(res.success).toBe(true);
    });

    it('rejects an unknown property key (still strict beyond the free-text fields)', () => {
      const res = FeedbackEventSchema.safeParse({
        ...FEEDBACK_SUBMITTED,
        properties: { ...FEEDBACK_SUBMITTED.properties, cwd: '/Users/kai/secret' },
      });
      expect(res.success).toBe(false);
    });

    it('rejects an over-long message', () => {
      const res = FeedbackEventSchema.safeParse({
        ...FEEDBACK_SUBMITTED,
        properties: {
          ...FEEDBACK_SUBMITTED.properties,
          message: 'x'.repeat(MAX_FEEDBACK_MESSAGE_LEN + 1),
        },
      });
      expect(res.success).toBe(false);
    });

    it('rejects a feedback_submitted with no kind', () => {
      const { kind: _kind, ...noKind } = FEEDBACK_SUBMITTED.properties;
      const res = FeedbackEventSchema.safeParse({ ...FEEDBACK_SUBMITTED, properties: noKind });
      expect(res.success).toBe(false);
    });

    it('rejects a feature_requested carrying a kind (that shape has no kind)', () => {
      const res = FeedbackEventSchema.safeParse({
        ...FEATURE_REQUESTED,
        properties: { ...FEATURE_REQUESTED.properties, kind: 'feedback' },
      });
      expect(res.success).toBe(false);
    });

    it('rejects an empty message', () => {
      const res = FeedbackEventSchema.safeParse({
        ...FEEDBACK_SUBMITTED,
        properties: { ...FEEDBACK_SUBMITTED.properties, message: '' },
      });
      expect(res.success).toBe(false);
    });
  });

  describe('free-text is unique to feedback', () => {
    it('the usage input schema rejects a free-text message property', () => {
      // Proves the no-PII allowlist still governs usage events: only feedback
      // events may carry prose.
      const res = TelemetryEventInputSchema.safeParse({
        event: 'session_created',
        properties: { runtime: 'claude-code', message: 'I typed this' },
      });
      expect(res.success).toBe(false);
    });

    it('the feedback property schemas require the message field', () => {
      expect(
        FeedbackSubmittedProperties.safeParse({ surface: 'cockpit', kind: 'bug' }).success
      ).toBe(false);
      expect(FeatureRequestedProperties.safeParse({ surface: 'site' }).success).toBe(false);
    });
  });

  describe('FeedbackSubmissionSchema (client → server payload)', () => {
    it('accepts a minimal submission', () => {
      const res = FeedbackSubmissionSchema.safeParse({ kind: 'feedback', message: 'nice work' });
      expect(res.success).toBe(true);
    });

    it('accepts the idea kind', () => {
      const res = FeedbackSubmissionSchema.safeParse({ kind: 'idea', message: 'add dark mode' });
      expect(res.success).toBe(true);
    });

    it('rejects an unknown kind', () => {
      const res = FeedbackSubmissionSchema.safeParse({ kind: 'praise', message: 'hi' });
      expect(res.success).toBe(false);
    });

    it('rejects unknown keys (strict)', () => {
      const res = FeedbackSubmissionSchema.safeParse({
        kind: 'bug',
        message: 'hi',
        surface: 'cockpit',
      });
      expect(res.success).toBe(false);
    });

    it('rejects a client-supplied reporterEmail (identity is server-resolved only)', () => {
      // reporterEmail/reporterName are never accepted on the client->server
      // submission at all — only on the built PostHog event, which the server
      // assembles from the verified session, never from the request body. A
      // client that tries to spoof one gets 400'd by the strict allowlist.
      const res = FeedbackSubmissionSchema.safeParse({
        kind: 'bug',
        message: 'hi',
        reporterEmail: 'attacker@evil.test',
      });
      expect(res.success).toBe(false);
    });

    it('accepts the new diagnostics/attachment plumbing fields', () => {
      const res = FeedbackSubmissionSchema.safeParse({
        kind: 'bug',
        message: 'crash on save',
        sessionId: 'sess_123',
        diagnostics: {
          clientReport: {
            version: '0.47.0',
            platform: 'darwin-arm64',
            runtimes: ['claude-code'],
            flags: { 'tunnel.enabled': true, 'ui.theme': 'dark' },
          },
          breadcrumbs: [{ at: VALID_TIMESTAMP, kind: 'console_error', message: 'TypeError: boom' }],
        },
        transcriptExcerpt: 'last few turns...',
        screenshotUploadId: 'upload_abc',
        includeServerLogs: true,
      });
      expect(res.success).toBe(true);
    });

    it('rejects diagnostics missing the required clientReport', () => {
      const res = FeedbackSubmissionSchema.safeParse({
        kind: 'bug',
        message: 'hi',
        diagnostics: { serverLogExcerpt: 'warn: something' },
      });
      expect(res.success).toBe(false);
    });

    it('rejects an oversized transcriptExcerpt', () => {
      const res = FeedbackSubmissionSchema.safeParse({
        kind: 'bug',
        message: 'hi',
        transcriptExcerpt: 'x'.repeat(MAX_TRANSCRIPT_LEN + 1),
      });
      expect(res.success).toBe(false);
    });
  });

  describe('FeedbackDiagnosticsSchema + BreadcrumbSchema', () => {
    it('accepts a minimal diagnostics bundle (clientReport only)', () => {
      const res = FeedbackDiagnosticsSchema.safeParse({
        clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
      });
      expect(res.success).toBe(true);
    });

    it('rejects a diagnostics bundle with no clientReport', () => {
      const res = FeedbackDiagnosticsSchema.safeParse({ breadcrumbs: [] });
      expect(res.success).toBe(false);
    });

    it('rejects an unknown clientReport key (strict, no path/token can ride along)', () => {
      const res = FeedbackDiagnosticsSchema.safeParse({
        clientReport: {
          version: '0.47.0',
          platform: 'darwin-arm64',
          runtimes: [],
          flags: {},
          cwd: '/Users/dorian/secret',
        },
      });
      expect(res.success).toBe(false);
    });

    it('rejects more breadcrumbs than MAX_BREADCRUMBS', () => {
      const res = FeedbackDiagnosticsSchema.safeParse({
        clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
        breadcrumbs: Array.from({ length: MAX_BREADCRUMBS + 1 }, () => ({
          at: VALID_TIMESTAMP,
          kind: 'console_error',
          message: 'x',
        })),
      });
      expect(res.success).toBe(false);
    });

    it('rejects an oversized serverLogExcerpt', () => {
      const res = FeedbackDiagnosticsSchema.safeParse({
        clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
        serverLogExcerpt: 'x'.repeat(MAX_LOG_EXCERPT_LEN + 1),
      });
      expect(res.success).toBe(false);
    });

    it('rejects an unknown breadcrumb kind', () => {
      const res = BreadcrumbSchema.safeParse({
        at: VALID_TIMESTAMP,
        kind: 'page_view',
        message: 'x',
      });
      expect(res.success).toBe(false);
    });
  });

  describe('buildFeedbackEvent', () => {
    it('maps bug/feedback kinds to feedback_submitted carrying the kind', () => {
      const event = buildFeedbackEvent(
        { kind: 'bug', message: 'broken', contact: 'a@b.com', route: '/tasks' },
        {
          surface: 'cockpit',
          distinctId: VALID_DISTINCT_ID,
          timestamp: VALID_TIMESTAMP,
          dorkosVersion: '0.47.0',
        }
      );
      expect(event.event).toBe('feedback_submitted');
      expect(event.properties).toMatchObject({
        kind: 'bug',
        message: 'broken',
        contact: 'a@b.com',
        route: '/tasks',
        surface: 'cockpit',
        dorkosVersion: '0.47.0',
      });
      expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
    });

    it('maps the idea kind to feature_requested with no kind property', () => {
      const event = buildFeedbackEvent(
        { kind: 'idea', message: 'add dark mode' },
        { surface: 'site', distinctId: 'ph_x', timestamp: VALID_TIMESTAMP }
      );
      expect(event.event).toBe('feature_requested');
      expect(event.properties).not.toHaveProperty('kind');
      expect(event.properties).not.toHaveProperty('contact');
      expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
    });

    it('omits optional fields that were not provided (strict-schema safe)', () => {
      const event = buildFeedbackEvent(
        { kind: 'feedback', message: 'hi' },
        { surface: 'site', distinctId: 'ph_x', timestamp: VALID_TIMESTAMP }
      );
      expect(event.properties).not.toHaveProperty('route');
      expect(event.properties).not.toHaveProperty('dorkosVersion');
      expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
    });

    it('attaches reporterEmail/reporterName from context.identity, never from the submission', () => {
      const event = buildFeedbackEvent(
        { kind: 'bug', message: 'broken' },
        {
          surface: 'cockpit',
          distinctId: VALID_DISTINCT_ID,
          timestamp: VALID_TIMESTAMP,
          identity: { userId: 'user_1', email: 'dorian@example.com', name: 'Dorian' },
        }
      );
      expect(event.properties).toMatchObject({
        reporterEmail: 'dorian@example.com',
        reporterName: 'Dorian',
      });
      // The identity's userId is never sent — only email/name.
      expect(JSON.stringify(event.properties)).not.toContain('user_1');
      expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
    });

    it('omits reporterEmail/reporterName when there is no identity (auth off / no session)', () => {
      const event = buildFeedbackEvent(
        { kind: 'bug', message: 'broken' },
        { surface: 'cockpit', distinctId: VALID_DISTINCT_ID, timestamp: VALID_TIMESTAMP }
      );
      expect(event.properties).not.toHaveProperty('reporterEmail');
      expect(event.properties).not.toHaveProperty('reporterName');
    });
  });
});
