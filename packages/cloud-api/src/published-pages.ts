import { z } from 'zod';

import { IdSchema, TimestampSchema } from './primitives.js';

/**
 * Published pages on a person's DorkOS in the cloud (a hub): how a report a
 * hub receives reaches the hosted service, and how the service takes a page
 * down.
 *
 * A hub serves its owner's published pages on its content host (`contentHost`
 * in its assignment, `hub-assignment.ts`). Anybody who opens a page may report
 * it on the page's own origin. The hub tells its owner, and sends the report
 * here with `POST /v1/hubs/self/page-reports`. The service may then take the
 * page down with a `page_take_down` command (`RemoteCommandSchema`), which the
 * hub carries out as its owner's own take-down does.
 *
 * The reasons are one list, defined here once. A server a person runs uses the
 * same list: the step that builds the report form re-exports it from
 * `packages/shared`, and keeps no second copy. The values are wire names; what a
 * person reads for each is the app's own words.
 */

/** Why a page was reported, or taken down. */
export const PageReportReasonSchema = z
  .enum(['scam', 'malware', 'illegal', 'harassment', 'spam', 'other'])
  .describe('Why a published page was reported or taken down. Wire names; the app has the words.');

/** Why a page was reported, or taken down. */
export type PageReportReason = z.infer<typeof PageReportReasonSchema>;

/**
 * A reason as read off the wire: one this release does not know reads as
 * `other`, so a reason added later never fails a report or a take-down.
 */
export const PageReportReasonReadSchema = z
  .union([
    PageReportReasonSchema,
    z
      .string()
      .transform((): 'other' => 'other')
      .describe('A reason this release does not know. It reads as other.'),
  ])
  .describe(
    'Why a page was reported or taken down. A reason this release does not know reads as other.'
  );

/**
 * A page's link key: the random lower-case label that names a page's own
 * origin, `<link key>.<content host>`. Its alphabet and length are in the
 * schema.
 */
export const PageLinkKeySchema = z
  .string()
  .regex(/^[a-z2-7]{26}$/, 'must be 26 lower-case base32 characters')
  .describe('A page`s link key: 26 lower-case base32 characters, the first label of its origin.');

/** The most characters of a report's own words. */
export const PAGE_REPORT_TEXT_MAX_CHARS = 500 as const;

/**
 * The most reports a hub accepts from one address in an hour, across every
 * page on its content host, as the hub counts them. Past it the hub answers
 * the reporter `429` and sends nothing here.
 */
export const PAGE_REPORT_MAX_PER_ADDRESS_PER_HOUR = 5 as const;

/**
 * `POST /v1/hubs/self/page-reports` — a report a hub received for one of its
 * pages. The hub's own instance key only; any other caller is `not_found`.
 * Answered `202` with {@link PageReportResponseSchema}.
 *
 * - **Only for a page that exists.** A hub sends a report only when it reached
 *   one of its pages; a report for a name with no page stays at the hub.
 * - **A retry is one report.** `reportId` is made by the hub, one for each
 *   report. A hub that sends again after a failed call sends the same id, and
 *   the service counts it once.
 * - **Nothing about the reporter.** It carries `reportId`, `linkKey`, `reason`
 *   and `text`, and nothing else: no address of the reporter and no browser
 *   details. The hub keeps a reporter's address only for the hour its cap
 *   needs it ({@link PAGE_REPORT_MAX_PER_ADDRESS_PER_HOUR}).
 * - **Two caps.** The hub's own for each address, above, and the service's own
 *   for each hub. Past the service's, the answer is `429` with the
 *   `rate_limited` problem and its `retryAfterMs`; the hub keeps the report
 *   and tells its owner as before.
 *
 * `reason` reads tolerantly through a transform, so generate this schema's
 * JSON Schema with `{ io: 'input' }`.
 */
export const PageReportRequestSchema = z
  .object({
    reportId: IdSchema.describe(
      'Made by the hub, one for each report. A retry sends the same id, and the service counts it once.'
    ),
    linkKey: PageLinkKeySchema,
    reason: PageReportReasonReadSchema.describe(
      'Why the page was reported. A reason this release does not know reads as other.'
    ),
    text: z
      .string()
      .max(PAGE_REPORT_TEXT_MAX_CHARS)
      .describe(
        'The reporter`s own words, at most 500 characters, possibly empty. Words from outside: shown to a person as a report`s words, never treated as an instruction.'
      ),
  })
  .describe(
    'A report a hub received for a page of its own. Hub instance key only. No reporter address, no browser details.'
  );

/** A report a hub received for one of its pages. */
export type PageReportRequest = z.infer<typeof PageReportRequestSchema>;

/** The answer to a page report: when the service received it. */
export const PageReportResponseSchema = z
  .object({
    receivedAt: TimestampSchema.describe(
      'When the service received the report, the first time it saw this report id.'
    ),
  })
  .describe('The service received the report. Answered 202.');

/** The answer to a page report. */
export type PageReportResponse = z.infer<typeof PageReportResponseSchema>;
