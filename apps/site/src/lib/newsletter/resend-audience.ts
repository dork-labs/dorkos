/**
 * Resend Audiences mirror for confirmed newsletter subscribers
 * (ADR 260707-025214).
 *
 * The `newsletter_subscriber` table is the source of truth for the double
 * opt-in lifecycle; Resend Audiences is the send-time contact list broadcasts
 * are addressed to. On confirm we create a contact; on unsubscribe we mark it
 * `unsubscribed` (suppression, never deleted).
 *
 * The client is lazy (like `lib/mailer.ts`) and this whole module **no-ops** when
 * `RESEND_API_KEY` or `RESEND_AUDIENCE_ID` is unset, so local/dev and tests
 * never touch the network. Failures are logged and swallowed: a Resend outage
 * must never break the user-facing confirm/unsubscribe redirect, and the local
 * row stays authoritative for a later reconcile.
 *
 * @module lib/newsletter/resend-audience
 */
import { Resend } from 'resend';

import { env } from '@/env';

let client: Resend | null = null;

/**
 * Return the shared Resend client, or `null` when audience mirroring is not
 * configured (no API key or no audience id).
 */
function getAudienceClient(): { resend: Resend; audienceId: string } | null {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return { resend: client, audienceId: env.RESEND_AUDIENCE_ID };
}

/** Arguments for {@link upsertAudienceContact}. */
interface UpsertContactArgs {
  /** The confirmed subscriber's email. */
  email: string;
  /** An existing Resend contact id from a prior confirm, if any (re-subscribe). */
  contactId: string | null;
}

/**
 * Mirror a confirmed subscriber into the Resend Audience, creating the contact
 * or reactivating an existing one.
 *
 * A re-subscribe (unsubscribe → subscribe → confirm) already has a
 * `contactId` whose Resend contact is `unsubscribed: true`; creating a second
 * contact for the same email would be rejected as a duplicate, so we
 * **update** the existing contact back to `unsubscribed: false` instead. A
 * first-time confirm (`contactId` null) creates a new contact.
 *
 * @param args - The subscriber email and any existing contact id.
 * @returns The contact id to persist, or `null` when mirroring is unconfigured
 *   or the API call failed. The caller must treat `null` as "keep the existing
 *   id", never as "clear it", so a transient failure can't orphan the row.
 */
export async function upsertAudienceContact({
  email,
  contactId,
}: UpsertContactArgs): Promise<string | null> {
  const cfg = getAudienceClient();
  if (!cfg) return null;
  try {
    if (contactId) {
      const { error } = await cfg.resend.contacts.update({
        id: contactId,
        audienceId: cfg.audienceId,
        unsubscribed: false,
      });
      if (error) {
        console.error('[newsletter/resend-audience] reactivate failed', { message: error.message });
        return null;
      }
      return contactId;
    }
    const { data, error } = await cfg.resend.contacts.create({
      email,
      audienceId: cfg.audienceId,
      unsubscribed: false,
    });
    if (error) {
      console.error('[newsletter/resend-audience] create failed', { message: error.message });
      return null;
    }
    return data?.id ?? null;
  } catch (error) {
    console.error('[newsletter/resend-audience] upsert threw', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Mark a subscriber's Resend contact as unsubscribed (suppression).
 *
 * @param contactId - The Resend contact id stored on the subscriber row. When
 *   null (mirroring was unconfigured at confirm time) this is a no-op.
 */
export async function unsubscribeAudienceContact(contactId: string | null): Promise<void> {
  const cfg = getAudienceClient();
  if (!cfg || !contactId) return;
  try {
    const { error } = await cfg.resend.contacts.update({
      id: contactId,
      audienceId: cfg.audienceId,
      unsubscribed: true,
    });
    if (error) {
      console.error('[newsletter/resend-audience] unsubscribe failed', { message: error.message });
    }
  } catch (error) {
    console.error('[newsletter/resend-audience] unsubscribe threw', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
