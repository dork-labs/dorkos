/**
 * The diagnostics text a feedback report carries to the durable route: the
 * desktop shell log beside the server's, sections with no room left, folded
 * breadcrumbs and the environment context lines.
 */
import { describe, expect, it } from 'vitest';

import type { FeedbackDiagnostics } from '@dorkos/shared/telemetry-events';

import { sendFeedback } from '../../feedback-reporter.js';
import {
  DURABLE_ENDPOINT,
  type FetchMock,
  bodyForUrl,
  feedbackOptions,
  makeFetch,
  useTempDorkHome,
} from './feedback-reporter.fixtures.js';

/** The `clientReport` half of a diagnostics bundle, typed from the schema. */
type ClientReport = FeedbackDiagnostics['clientReport'];

const dorkHome = useTempDorkHome();

/** Default options shared by most `sendFeedback` calls below. */
function baseOptions(
  overrides: Partial<Parameters<typeof sendFeedback>[0]> = {}
): Parameters<typeof sendFeedback>[0] {
  return feedbackOptions(dorkHome(), overrides);
}

/** Parse the JSON body of the call made to the durable endpoint. */
function durableBody(fetchImpl: FetchMock): Record<string, unknown> {
  return bodyForUrl(fetchImpl, DURABLE_ENDPOINT);
}

describe('sendFeedback — diagnostics text', () => {
  it("names the desktop shell's own log apart from the server's (DOR-2045)", async () => {
    // Without a section of its own the field is inert: it would reach the route,
    // validate, and then never appear in the report anyone reads. The two logs
    // are labelled separately because they come from different processes and a
    // reader has to know which one said what.
    const fetchImpl = makeFetch('ok');
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'the window keeps reloading itself',
          diagnostics: {
            clientReport: {
              version: '0.75.0',
              platform: 'darwin-arm64',
              runtimes: [],
              flags: {},
              shell: 'desktop-app' as const,
            },
            serverLogExcerpt: '2026-09-14T22:25:25.000Z warn [http] slow request',
            shellLogExcerpt: '2026-09-14 15:25:25.123 info [renderer] Reloading the window.',
          },
        },
        fetchImpl,
      })
    );

    const diagnostics = durableBody(fetchImpl).diagnostics as string;
    expect(diagnostics).toContain('Server log excerpt:\n2026-09-14T22:25:25.000Z warn');
    expect(diagnostics).toContain(
      'Desktop app log excerpt:\n2026-09-14 15:25:25.123 info [renderer] Reloading the window.'
    );
  });

  it('says so in the report when a section had no room, instead of vanishing', async () => {
    // `flags` is an uncapped record, so a report CAN arrive with almost the
    // whole block already spent. A section that silently disappears reads as
    // "there was no log", which sends triage looking in the wrong place.
    const fetchImpl = makeFetch('ok');
    // 166 flags is the middle of the band (measured 163-169) where the header
    // leaves room to NAME what was dropped but not to carry it: below it the
    // excerpts still fit front-cut, above it not even the markers do.
    const flags = Object.fromEntries(
      Array.from({ length: 166 }, (_, i) => [`f${i}`, 'v'.repeat(40)])
    );

    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'the window keeps reloading itself',
          diagnostics: {
            clientReport: {
              version: '0.75.0',
              platform: 'darwin-arm64',
              runtimes: [],
              flags,
              shell: 'desktop-app' as const,
            },
            serverLogExcerpt: `2026-09-14T22:25:00.000Z warn [http] slow ${'y'.repeat(4000)}`,
            shellLogExcerpt: `2026-09-14 15:25:25.123 info [renderer] reload ${'z'.repeat(4000)}`,
          },
        },
        fetchImpl,
      })
    );

    const diagnostics = durableBody(fetchImpl).diagnostics as string;
    expect(diagnostics.length).toBeLessThanOrEqual(8000);
    expect(diagnostics).toContain('Server log excerpt: (omitted, no room)');
    expect(diagnostics).toContain('Desktop app log excerpt: (omitted, no room)');
  });

  it('folds a run of identical breadcrumbs into one line with a count (DOR-2234)', async () => {
    // A retry loop logs the same crumb many times in a row; printed one per
    // line it buried the crumbs around it and spent the shared budget.
    const fetchImpl = makeFetch('ok');
    type Crumb = NonNullable<FeedbackDiagnostics['breadcrumbs']>[number];
    const crumb = (at: string, kind: Crumb['kind'], message: string): Crumb => ({
      at,
      kind,
      message,
    });
    await sendFeedback(
      baseOptions({
        submission: {
          kind: 'bug',
          message: 'it keeps retrying',
          diagnostics: {
            clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
            breadcrumbs: [
              crumb('2026-08-03T00:00:00.000Z', 'sse_disconnect', 'stream closed'),
              crumb('2026-08-03T00:00:01.000Z', 'console_error', 'fetch failed'),
              crumb('2026-08-03T00:00:02.000Z', 'console_error', 'fetch failed'),
              crumb('2026-08-03T00:00:03.000Z', 'console_error', 'fetch failed'),
              crumb('2026-08-03T00:00:04.000Z', 'query_error', 'rooms failed'),
              // Same words, different kind: not a repeat.
              crumb('2026-08-03T00:00:05.000Z', 'console_warn', 'rooms failed'),
              // A repeat that is not adjacent keeps its own place in time.
              crumb('2026-08-03T00:00:06.000Z', 'console_error', 'fetch failed'),
            ],
          },
        },
        fetchImpl,
      })
    );

    const diagnostics = durableBody(fetchImpl).diagnostics as string;
    const crumbs = diagnostics.split('Breadcrumbs:\n')[1]!.split('\n');
    expect(crumbs).toEqual([
      '[2026-08-03T00:00:00.000Z] sse_disconnect: stream closed',
      '[2026-08-03T00:00:01.000Z] console_error: fetch failed (x3, last 2026-08-03T00:00:03.000Z)',
      '[2026-08-03T00:00:04.000Z] query_error: rooms failed',
      '[2026-08-03T00:00:05.000Z] console_warn: rooms failed',
      '[2026-08-03T00:00:06.000Z] console_error: fetch failed',
    ]);
  });

  describe('diagnostics context lines (DOR-1960)', () => {
    /** A `clientReport` carrying every environment field the client can capture. */
    function reportWithEnvironment(overrides: Partial<ClientReport> = {}): ClientReport {
      return {
        version: '0.47.0',
        platform: 'darwin-arm64',
        runtimes: ['claude-code'],
        flags: {},
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        browser: 'Mozilla/5.0 (Macintosh) TestBrowser/1.0',
        shell: 'desktop-app' as const,
        theme: 'dark' as const,
        locale: 'en-GB',
        timezone: 'Europe/London',
        ...overrides,
      };
    }

    /** Send one submission with the given clientReport and return the rendered text. */
    async function renderedFor(
      clientReport: ClientReport,
      options: Partial<Parameters<typeof sendFeedback>[0]> = {}
    ): Promise<string> {
      const fetchImpl = makeFetch('ok');
      await sendFeedback(
        baseOptions({
          submission: { kind: 'bug', message: 'layout broke', diagnostics: { clientReport } },
          fetchImpl,
          ...options,
        })
      );
      return durableBody(fetchImpl).diagnostics as string;
    }

    it('renders every captured environment field as a Key: value line', async () => {
      const diagnostics = await renderedFor(reportWithEnvironment());

      // Asserted as whole lines, not substrings: the site fences this text
      // verbatim into the Linear issue, so the LINE is the contract a human
      // reads. A bare `toContain('dark')` would also pass on `darwin-arm64`.
      const lines = diagnostics.split('\n');
      expect(lines).toContain('Viewport: 1280x720 @2x');
      expect(lines).toContain('Shell: desktop-app');
      expect(lines).toContain('Theme: dark');
      expect(lines).toContain('Locale: en-GB');
      expect(lines).toContain('Timezone: Europe/London');
      expect(lines).toContain('Browser: Mozilla/5.0 (Macintosh) TestBrowser/1.0');
    });

    it.each([
      { client: '0.47.0', server: '0.47.0', line: 'Version: 0.47.0' },
      // Upgrade skew: a long-lived tab holding a cached config.
      { client: '0.47.0', server: '0.48.1', line: 'Version: 0.47.0 (server 0.48.1)' },
      // `unknown` is a loading state, not a version, so it is not skew.
      { client: 'unknown', server: '0.48.1', line: 'Version: 0.48.1' },
    ])('renders client $client / server $server as "$line"', async ({ client, server, line }) => {
      const diagnostics = await renderedFor(reportWithEnvironment({ version: client }), {
        dorkosVersion: server,
      });
      expect(diagnostics.split('\n')).toContain(line);
    });

    it('keeps the context lines when a full breadcrumb trail overruns the 8000-char cap', async () => {
      // Breadcrumbs alone reach ~17,000 characters at their own caps (50 x 300),
      // so the final slice is a live possibility on a real report. The context
      // header must be on the surviving side of it — which is only true while
      // the header is rendered BEFORE the breadcrumb section.
      const fetchImpl = makeFetch('ok');
      await sendFeedback(
        baseOptions({
          submission: {
            kind: 'bug',
            message: 'layout broke',
            diagnostics: {
              clientReport: reportWithEnvironment(),
              breadcrumbs: Array.from({ length: 50 }, (_, i) => ({
                at: '2026-08-03T00:00:00.000Z',
                kind: 'console_error' as const,
                message: `${i}-${'x'.repeat(295)}`,
              })),
            },
          },
          fetchImpl,
        })
      );

      const diagnostics = durableBody(fetchImpl).diagnostics as string;
      expect(diagnostics).toHaveLength(8000);
      const lines = diagnostics.split('\n');
      expect(lines).toContain('Viewport: 1280x720 @2x');
      expect(lines).toContain('Theme: dark');
      expect(lines).toContain('Browser: Mozilla/5.0 (Macintosh) TestBrowser/1.0');
    });
  });
});
