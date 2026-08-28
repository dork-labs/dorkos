/**
 * `GET /api/feedback/[id]` — public, read-only status lookup for one feedback
 * submission (feedback-pipeline Part 4, decision 260803-205035).
 *
 * The link a receipt email sends the reporter to (`/feedback/[id]`, the page
 * component next to this route) resolves through here. No auth: the row id
 * is an unguessable random uuid, so knowing it is the access control — the
 * same posture as the rest of this pipeline's `instanceId`-scoped surfaces.
 *
 * **Deliberately returns only `{ status, kind, createdAt, shippedVersion? }`.**
 * Never the message, contact, reporter identity, or Linear ids/urls — those
 * are private to the core team, and the whole point of mirroring status back
 * through this table rather than exposing Linear directly is that the
 * reporter never sees Linear internals (rewritten titles, assignees,
 * comments). Runs on the `edge` runtime: read-only, no secrets, and the
 * lightest possible path for a link that may get clicked straight from an
 * email client.
 *
 * @module app/api/feedback/[id]
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { feedbackSubmission } from '@/db/feedback-schema';
import { consumeFeedbackStatusQuota } from '@/lib/feedback/status-rate-limit';

export const runtime = 'edge';

const IdSchema = z.string().uuid();

/** The only fields a caller may ever see for a submission. */
interface PublicFeedbackStatus {
  status: string;
  kind: string;
  createdAt: string;
  shippedVersion?: string;
}

function notFound(): Response {
  return Response.json({ error: 'Not found' }, { status: 404 });
}

/**
 * Look up one submission's public status.
 *
 * `429` when this IP is over its limit. Otherwise `404` for a malformed id or
 * one that matches no row — the two cases are indistinguishable on the wire on
 * purpose (enumeration-safe: a syntactically valid but non-existent id carries
 * no more information than a garbled one).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Charged before the id is parsed: a loop guessing uuids is the traffic this
  // exists to slow, and a malformed id costs a request either way.
  const quota = consumeFeedbackStatusQuota(request);
  if (!quota.allowed) {
    return Response.json(
      { error: 'Too many requests. Retry after the number of seconds in the Retry-After header.' },
      { status: 429, headers: { 'retry-after': String(quota.retryAfterSeconds) } }
    );
  }

  const { id } = await params;
  const parsedId = IdSchema.safeParse(id);
  if (!parsedId.success) return notFound();

  const db = getDb();
  const [row] = await db
    .select({
      status: feedbackSubmission.status,
      kind: feedbackSubmission.kind,
      createdAt: feedbackSubmission.createdAt,
      shippedVersion: feedbackSubmission.shippedVersion,
    })
    .from(feedbackSubmission)
    .where(eq(feedbackSubmission.id, parsedId.data))
    .limit(1);

  if (!row) return notFound();

  const body: PublicFeedbackStatus = {
    status: row.status,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    ...(row.shippedVersion ? { shippedVersion: row.shippedVersion } : {}),
  };
  return Response.json(body);
}
