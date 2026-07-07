/**
 * Resend Segment mirror for confirmed newsletter subscribers
 * (ADR 260707-025214).
 *
 * The `newsletter_subscriber` table is the source of truth for the double
 * opt-in lifecycle; a Resend **Segment** is the send-time list broadcasts are
 * addressed to. Resend's 2025 migration retired Audiences in favour of
 * Segments: contacts are now account-global, and a broadcast targets a segment.
 * On confirm we create (or reactivate) the global contact and add it to the
 * DorkOS Newsletter segment; on unsubscribe we set the contact's account-wide
 * `unsubscribed` flag (fine while there is a single stream — revisit with
 * Topics when a second stream ships).
 *
 * The client is lazy (like `lib/mailer.ts`) and this whole module **no-ops** when
 * `RESEND_API_KEY` or `RESEND_SEGMENT_ID` is unset, so preview/local and tests
 * never touch the network. Failures are logged and swallowed: a Resend outage
 * must never break the user-facing confirm/unsubscribe redirect, and the local
 * row stays authoritative for a later reconcile.
 *
 * @module lib/newsletter/resend-segment
 */
import { Resend } from 'resend';

import { env } from '@/env';

let client: Resend | null = null;

/**
 * Return the shared Resend client, or `null` when segment mirroring is not
 * configured (no API key or no segment id).
 */
function getSegmentClient(): { resend: Resend; segmentId: string } | null {
  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return { resend: client, segmentId: env.RESEND_SEGMENT_ID };
}

/** Arguments for {@link upsertSegmentContact}. */
interface UpsertContactArgs {
  /** The confirmed subscriber's email. */
  email: string;
  /** An existing Resend contact id from a prior confirm, if any (re-subscribe). */
  contactId: string | null;
}

/**
 * Mirror a confirmed subscriber into the DorkOS Newsletter segment, creating
 * the global contact or reactivating an existing one.
 *
 * First-time confirm (`contactId` null): create the global contact already
 * attached to the segment. Re-subscribe (`contactId` set): the global contact
 * still exists (its account-wide `unsubscribed` flag was set on the earlier
 * unsubscribe), so flip it back to subscribed and re-add it to the segment
 * rather than creating a duplicate.
 *
 * @param args - The subscriber email and any existing contact id.
 * @returns The contact id to persist, or `null` when mirroring is unconfigured
 *   or the API call failed. The caller must treat `null` as "keep the existing
 *   id", never as "clear it", so a transient failure can't orphan the row.
 */
export async function upsertSegmentContact({
  email,
  contactId,
}: UpsertContactArgs): Promise<string | null> {
  const cfg = getSegmentClient();
  if (!cfg) return null;
  try {
    if (contactId) {
      const { error } = await cfg.resend.contacts.update({
        id: contactId,
        unsubscribed: false,
      });
      if (error) {
        console.error('[newsletter/resend-segment] reactivate failed', { message: error.message });
        return null;
      }
      await addToSegment(cfg, contactId);
      return contactId;
    }
    const { data, error } = await cfg.resend.contacts.create({
      email,
      unsubscribed: false,
      segments: [{ id: cfg.segmentId }],
    });
    if (error) {
      console.error('[newsletter/resend-segment] create failed', { message: error.message });
      return null;
    }
    return data?.id ?? null;
  } catch (error) {
    console.error('[newsletter/resend-segment] upsert threw', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Best-effort add of an existing contact to the segment. A contact already in
 * the segment is not an error worth failing the confirm over, so failures are
 * logged and swallowed.
 */
async function addToSegment(
  cfg: { resend: Resend; segmentId: string },
  contactId: string
): Promise<void> {
  const { error } = await cfg.resend.contacts.segments.add({
    contactId,
    segmentId: cfg.segmentId,
  });
  if (error) {
    console.error('[newsletter/resend-segment] add-to-segment failed', { message: error.message });
  }
}

/**
 * Mark a subscriber's Resend contact as unsubscribed (account-wide opt-out).
 *
 * @param contactId - The Resend contact id stored on the subscriber row. When
 *   null (mirroring was unconfigured at confirm time) this is a no-op.
 */
export async function unsubscribeContact(contactId: string | null): Promise<void> {
  const cfg = getSegmentClient();
  if (!cfg || !contactId) return;
  try {
    const { error } = await cfg.resend.contacts.update({
      id: contactId,
      unsubscribed: true,
    });
    if (error) {
      console.error('[newsletter/resend-segment] unsubscribe failed', { message: error.message });
    }
  } catch (error) {
    console.error('[newsletter/resend-segment] unsubscribe threw', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
