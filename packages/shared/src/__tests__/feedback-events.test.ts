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
  buildFeedbackEvent,
  MAX_FEEDBACK_MESSAGE_LEN,
  MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN,
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

describe('feedback event registry', () => {
  describe('FeedbackEventSchema', () => {
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
  });

  describe('FeedbackSubmissionSchema (client → server payload)', () => {
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

    describe('screenshot', () => {
      it('rejects a data URL whose media type is not one of the three images', () => {
        // `image/svg+xml` is the pointed case: an image type that is also an
        // executable document, so it must not ride into a Linear description.
        for (const bad of [
          'data:image/svg+xml;base64,QUJD',
          'data:text/html;base64,QUJD',
          'data:image/gif;base64,QUJD',
        ]) {
          const res = FeedbackSubmissionSchema.safeParse({
            kind: 'bug',
            message: 'crash on save',
            screenshot: { dataUrl: bad },
          });
          expect(res.success).toBe(false);
        }
      });

      it('rejects a data URL one character over the cap, and accepts one exactly at it', () => {
        const prefix = 'data:image/webp;base64,';
        const atCap = prefix + 'A'.repeat(MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN - prefix.length);
        expect(atCap.length).toBe(MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN);

        const ok = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshot: { dataUrl: atCap },
        });
        expect(ok.success).toBe(true);

        const tooBig = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshot: { dataUrl: `${atCap}A` },
        });
        expect(tooBig.success).toBe(false);
      });
    });

    describe('element (DOR-2232)', () => {
      const base = { kind: 'bug' as const, message: 'Messages vanish when I scroll up.' };

      it('rejects an element with no selector, or an empty one', () => {
        expect(
          FeedbackSubmissionSchema.safeParse({ ...base, element: { slot: 'button' } }).success
        ).toBe(false);
        expect(
          FeedbackSubmissionSchema.safeParse({ ...base, element: { selector: '' } }).success
        ).toBe(false);
      });

      it('never rides the metrics event', () => {
        const event = buildFeedbackEvent(
          { ...base, element: { selector: 'div' } },
          { surface: 'cockpit', distinctId: VALID_DISTINCT_ID, timestamp: VALID_TIMESTAMP }
        );
        expect(JSON.stringify(event)).not.toContain('element');
        expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
      });
    });
  });

  describe('FeedbackDiagnosticsSchema + BreadcrumbSchema', () => {
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

    describe('environment context (DOR-1960)', () => {
      /** A clientReport with the four always-present fields plus `extra`. */
      function report(extra: Record<string, unknown> = {}) {
        return {
          clientReport: {
            version: '0.47.0',
            platform: 'darwin-arm64',
            runtimes: [],
            flags: {},
            ...extra,
          },
        };
      }

      it('has no slot for a location, a cwd, or a workspace path', () => {
        // The strict allowlist IS the privacy contract. These are the three
        // things the diagnostics bundle deliberately does not carry.
        //
        // This guards only the BUNDLE. The other way a path could reach the
        // wire is the submission's `route`, since `/session` URLs carry the
        // absolute cwd in `?dir=`; that half is guarded by the query allowlist
        // in `features/feedback/lib/feedback-route.ts` and its own tests. Both
        // doors have to stay shut for this assertion to mean what it says.
        for (const forbidden of [
          { geolocation: { lat: 1, lon: 2 } },
          { cwd: '/Users/dorian/secret-project' },
          { workspacePath: '/Users/dorian/vault' },
        ]) {
          expect(FeedbackDiagnosticsSchema.safeParse(report(forbidden)).success).toBe(false);
        }
      });
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
  });
});
