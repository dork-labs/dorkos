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
  MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN,
  MAX_BREADCRUMBS,
  MAX_TRANSCRIPT_LEN,
  MAX_LOG_EXCERPT_LEN,
  MAX_CLIENT_REPORT_BROWSER_LEN,
  MAX_CLIENT_REPORT_TAG_LEN,
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
        screenshot: { dataUrl: 'data:image/webp;base64,UklGRhoAAABXRUJQ' },
        includeServerLogs: true,
        includeTranscript: true,
        anonymous: true,
      });
      expect(res.success).toBe(true);
    });

    describe('screenshot', () => {
      /** A valid, tiny WebP data URL — the shape the client's compression step emits. */
      const validDataUrl = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4';

      it('round-trips a submission carrying a screenshot', () => {
        const res = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshot: { dataUrl: validDataUrl },
        });
        expect(res.success).toBe(true);
        // Parsed back out intact — a stripped field would still report success.
        expect(res.success && res.data.screenshot?.dataUrl).toBe(validDataUrl);
      });

      it('round-trips a submission with no screenshot at all', () => {
        const res = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
        });
        expect(res.success).toBe(true);
        expect(res.success && res.data.screenshot).toBeUndefined();
      });

      it.each(['image/webp', 'image/png', 'image/jpeg'])('accepts %s', (mime) => {
        const res = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshot: { dataUrl: `data:${mime};base64,QUJD` },
        });
        expect(res.success).toBe(true);
      });

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

      it('rejects a non-base64 image URL (a remote http src is not an inline image)', () => {
        const res = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshot: { dataUrl: 'https://example.com/shot.png' },
        });
        expect(res.success).toBe(false);
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

      it('rejects unknown keys inside screenshot', () => {
        const res = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshot: { dataUrl: validDataUrl, mime: 'image/webp' },
        });
        expect(res.success).toBe(false);
      });

      it('no longer accepts the retired screenshotUploadId field', () => {
        // The upload-reference design was replaced by the inline data URL
        // above; `.strict()` is what makes the removal enforceable at runtime
        // rather than a silently-ignored leftover.
        const res = FeedbackSubmissionSchema.safeParse({
          kind: 'bug',
          message: 'crash on save',
          screenshotUploadId: 'upload_abc',
        });
        expect(res.success).toBe(false);
      });
    });

    it('accepts the opt-in transcript + anonymous flags on their own', () => {
      const res = FeedbackSubmissionSchema.safeParse({
        kind: 'bug',
        message: 'crash on save',
        sessionId: 'sess_123',
        includeTranscript: true,
        anonymous: true,
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

      it('accepts a fully-populated environment', () => {
        const res = FeedbackDiagnosticsSchema.safeParse(
          report({
            viewport: { width: 1512, height: 856, devicePixelRatio: 2 },
            browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            shell: 'desktop-app',
            theme: 'dark',
            locale: 'en-US',
            timezone: 'America/Los_Angeles',
          })
        );
        expect(res.success).toBe(true);
      });

      it('accepts a bundle with none of them (a client that predates the fields)', () => {
        expect(FeedbackDiagnosticsSchema.safeParse(report()).success).toBe(true);
      });

      it('rejects a fractional viewport dimension', () => {
        // A zoomed window reports fractional CSS pixels; the client rounds them.
        // If it stops rounding, this refusal is what makes that a loud failure.
        const res = FeedbackDiagnosticsSchema.safeParse(
          report({ viewport: { width: 1512.5, height: 856, devicePixelRatio: 2 } })
        );
        expect(res.success).toBe(false);
      });

      it('rejects an unknown key inside viewport (strict all the way down)', () => {
        const res = FeedbackDiagnosticsSchema.safeParse(
          report({
            viewport: { width: 100, height: 100, devicePixelRatio: 1, screenX: 40 },
          })
        );
        expect(res.success).toBe(false);
      });

      it('rejects an over-cap browser string', () => {
        const res = FeedbackDiagnosticsSchema.safeParse(
          report({ browser: 'x'.repeat(MAX_CLIENT_REPORT_BROWSER_LEN + 1) })
        );
        expect(res.success).toBe(false);
      });

      it('rejects an over-cap locale or timezone', () => {
        const tooLong = 'x'.repeat(MAX_CLIENT_REPORT_TAG_LEN + 1);
        expect(FeedbackDiagnosticsSchema.safeParse(report({ locale: tooLong })).success).toBe(
          false
        );
        expect(FeedbackDiagnosticsSchema.safeParse(report({ timezone: tooLong })).success).toBe(
          false
        );
      });

      it('rejects a shell or theme outside its enum', () => {
        // Both are closed sets, so a free-form string cannot ride in on either
        // — that is what keeps them context rather than another text field.
        expect(FeedbackDiagnosticsSchema.safeParse(report({ shell: 'terminal' })).success).toBe(
          false
        );
        expect(FeedbackDiagnosticsSchema.safeParse(report({ theme: 'system' })).success).toBe(
          false
        );
      });

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
