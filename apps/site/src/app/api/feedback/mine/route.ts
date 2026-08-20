/**
 * `GET /api/feedback/mine?instanceId=` — public, `instanceId`-scoped list of
 * one install's own feedback submissions (feedback-pipeline Part 4, decision
 * 260803-205035).
 *
 * The cockpit's "Product feedback" tracking view reads this through the
 * local server's `GET /api/feedback/mine` proxy (`apps/server`), which
 * resolves this install's own anonymous `instanceId` and forwards it here —
 * this route never sees a request straight from a browser. No login: the
 * `instanceId` is the access control, matching every other pseudonymous
 * surface in this pipeline.
 *
 * Unlike `/api/feedback/[id]` (single-row, status only), this route **does**
 * include `message` and the `hasScreenshot`/`hasTranscript` attachment flags
 * (design-decisions.md §7's attachment hint) — it is the reporter's own
 * text and their own submission metadata, and the caller already holds the
 * private per-install id that scopes the query to exactly their own
 * submissions. Still never Linear ids/urls, contact, or reporter identity:
 * those stay team-private regardless of who is asking.
 *
 * Runs on the `edge` runtime, same reasoning as `/api/feedback/[id]`:
 * read-only, no secrets.
 *
 * @module app/api/feedback/mine
 */
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { feedbackSubmission } from '@/db/feedback-schema';

export const runtime = 'edge';

/** Mirrors the cap on `POST /api/feedback`'s `instanceId` field. */
const MAX_INSTANCE_ID_LEN = 128;
/** Bound the response so one install's history page can never grow unbounded. */
const MAX_ROWS = 200;

const InstanceIdSchema = z.string().min(1).max(MAX_INSTANCE_ID_LEN);

/** One row of the tracking view's list, as sent over the wire. */
interface FeedbackListItem {
  id: string;
  kind: string;
  message: string;
  status: string;
  createdAt: string;
  shippedVersion?: string;
  hasScreenshot: boolean;
  hasTranscript: boolean;
}

/**
 * List every submission for one install, newest first.
 *
 * `400` only for a missing/malformed `instanceId` query param — a
 * well-formed id that happens to match nothing simply returns `[]`, so the
 * response shape can never be used to probe whether an id is "real".
 */
export async function GET(request: Request): Promise<Response> {
  const instanceId = new URL(request.url).searchParams.get('instanceId');
  const parsed = InstanceIdSchema.safeParse(instanceId);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid instanceId' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: feedbackSubmission.id,
      kind: feedbackSubmission.kind,
      message: feedbackSubmission.message,
      status: feedbackSubmission.status,
      createdAt: feedbackSubmission.createdAt,
      shippedVersion: feedbackSubmission.shippedVersion,
      hasScreenshot: feedbackSubmission.hasScreenshot,
      hasTranscript: feedbackSubmission.hasTranscript,
    })
    .from(feedbackSubmission)
    .where(eq(feedbackSubmission.instanceId, parsed.data))
    .orderBy(desc(feedbackSubmission.createdAt))
    .limit(MAX_ROWS);

  const items: FeedbackListItem[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    hasScreenshot: row.hasScreenshot,
    hasTranscript: row.hasTranscript,
    ...(row.shippedVersion ? { shippedVersion: row.shippedVersion } : {}),
  }));

  return Response.json(items);
}
