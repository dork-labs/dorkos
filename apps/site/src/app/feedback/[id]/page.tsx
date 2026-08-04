import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { feedbackSubmission } from '@/db/feedback-schema';
import { MarketingChrome } from '@/layers/features/marketing';
import { feedbackStatusLabel } from '@/lib/feedback/status-labels';

export const runtime = 'edge';

export const metadata: Metadata = {
  title: 'Report status — DorkOS',
  robots: { index: false },
};

const KIND_LABEL: Record<string, string> = {
  bug: 'bug report',
  idea: 'idea',
  feedback: 'feedback',
};

const IdSchema = z.string().uuid();

/**
 * `/feedback/[id]` — the public status page a "we got your report" receipt
 * email links to (feedback-pipeline Part 4, decision 260803-205035).
 *
 * Reads the same allowlisted projection as `GET /api/feedback/[id]` directly
 * (no self-fetch round trip) — status, kind, and createdAt only, never the
 * message, contact, or Linear internals. No auth: the row id is an
 * unguessable uuid, matching this pipeline's pseudonymous posture throughout.
 */
export default async function FeedbackStatusPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const parsedId = IdSchema.safeParse(id);
  if (!parsedId.success) notFound();

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

  if (!row) notFound();

  const kindLabel = KIND_LABEL[row.kind] ?? 'report';
  const statusLabel = feedbackStatusLabel(row.status, row.shippedVersion);

  return (
    <MarketingChrome>
      <main className="mx-auto max-w-xl px-6 pt-32 pb-24 text-center">
        <h1 className="text-charcoal font-mono text-2xl font-bold tracking-tight sm:text-3xl">
          Your {kindLabel}
        </h1>
        <p className="text-warm-gray mt-4 text-lg">
          Sent{' '}
          {row.createdAt.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
          . Current status:
        </p>
        <p className="text-charcoal mt-2 font-mono text-xl font-semibold">{statusLabel}</p>
        <div className="mt-8 flex justify-center gap-4 font-mono text-sm">
          <Link href="/" className="text-charcoal hover:text-brand-orange underline">
            Back home
          </Link>
        </div>
      </main>
    </MarketingChrome>
  );
}
