'use client';

/**
 * Submit logic for the newsletter signup form (ADR 260707-025214).
 *
 * Owns the small idle → submitting → success | error state machine, POSTs to
 * `/api/newsletter/subscribe`, and fires the consent-gated PostHog
 * `newsletter_signup` event on success. A honeypot value short-circuits to a
 * fake success so bots never learn they were caught. No PII leaves the browser:
 * the analytics event carries only the capture `source` and the email domain.
 *
 * The route throttles per IP, so a `429` is a normal answer here, not a bug —
 * it gets its own wait-and-retry sentence instead of the generic error.
 *
 * **{@link ERROR_COPY} is the only newsletter error copy a visitor ever sees.**
 * The route's JSON error bodies are for whoever calls the endpoint directly;
 * this hook never reads them, so the two are free to differ and neither is a
 * stale copy of the other.
 *
 * @module shared/ui/newsletter-signup/use-newsletter-form
 */
import { useState } from 'react';

import { trackNewsletterSignup } from '@/lib/analytics';
import type { NewsletterSource } from '@/db/newsletter-schema';

/** Form lifecycle state. */
export type NewsletterFormState = 'idle' | 'submitting' | 'success' | 'error';

/**
 * Why a submit failed. Only `invalid-email` says anything about the address the
 * visitor typed — the other two are about the request, and a field marked
 * invalid for either would be telling the visitor something untrue.
 */
export type NewsletterErrorKind = 'invalid-email' | 'rate-limited' | 'unknown';

/** What {@link useNewsletterForm} returns to the view. */
export interface UseNewsletterForm {
  /** Current lifecycle state. */
  state: NewsletterFormState;
  /** Human-readable error message when `state === 'error'`. */
  error: string | null;
  /** Why the last submit failed, or `null` when nothing has failed. */
  errorKind: NewsletterErrorKind | null;
  /** Submit an email. `honeypot` is the bot-trap field value (should be empty). */
  submit: (email: string, honeypot: string) => Promise<void>;
  /** Reset back to `idle` (e.g. to let a user add another address). */
  reset: () => void;
}

/** The one sentence a visitor sees for each way a submit can fail. */
const ERROR_COPY: Record<NewsletterErrorKind, string> = {
  'invalid-email': 'Please enter a valid email address.',
  // The route throttles per IP (DOR-1581); say what to do about it.
  'rate-limited': 'Too many tries. Please wait a few minutes and try again.',
  unknown: 'Something went wrong. Please try again.',
};

/** Extract the domain from an email for non-PII analytics, or `'unknown'`. */
function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? 'unknown';
}

/** Classify a failed response status. */
function errorKindFor(status: number): NewsletterErrorKind {
  if (status === 400) return 'invalid-email';
  if (status === 429) return 'rate-limited';
  return 'unknown';
}

/**
 * Hook powering a newsletter signup form for a given capture source.
 *
 * @param source - Which capture surface is rendering the form.
 * @returns The form state and a `submit` action.
 */
export function useNewsletterForm(source: NewsletterSource): UseNewsletterForm {
  const [state, setState] = useState<NewsletterFormState>('idle');
  const [errorKind, setErrorKind] = useState<NewsletterErrorKind | null>(null);

  async function submit(email: string, honeypot: string): Promise<void> {
    // Bot filled the hidden field: pretend it worked, do nothing.
    if (honeypot) {
      setState('success');
      return;
    }
    setState('submitting');
    setErrorKind(null);
    try {
      const res = await fetch('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, source }),
      });
      if (!res.ok) {
        setState('error');
        setErrorKind(errorKindFor(res.status));
        return;
      }
      trackNewsletterSignup(source, emailDomain(email));
      setState('success');
    } catch {
      setState('error');
      setErrorKind('unknown');
    }
  }

  function reset(): void {
    setState('idle');
    setErrorKind(null);
  }

  return { state, error: errorKind && ERROR_COPY[errorKind], errorKind, submit, reset };
}
