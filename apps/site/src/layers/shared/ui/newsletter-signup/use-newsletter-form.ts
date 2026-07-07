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
 * @module shared/ui/newsletter-signup/use-newsletter-form
 */
import { useState } from 'react';
import posthog from 'posthog-js';

import type { NewsletterSource } from '@/db/newsletter-schema';

/** Form lifecycle state. */
export type NewsletterFormState = 'idle' | 'submitting' | 'success' | 'error';

/** What {@link useNewsletterForm} returns to the view. */
export interface UseNewsletterForm {
  /** Current lifecycle state. */
  state: NewsletterFormState;
  /** Human-readable error message when `state === 'error'`. */
  error: string | null;
  /** Submit an email. `honeypot` is the bot-trap field value (should be empty). */
  submit: (email: string, honeypot: string) => Promise<void>;
  /** Reset back to `idle` (e.g. to let a user add another address). */
  reset: () => void;
}

/** Extract the domain from an email for non-PII analytics, or `'unknown'`. */
function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? 'unknown';
}

/**
 * Hook powering a newsletter signup form for a given capture source.
 *
 * @param source - Which capture surface is rendering the form.
 * @returns The form state and a `submit` action.
 */
export function useNewsletterForm(source: NewsletterSource): UseNewsletterForm {
  const [state, setState] = useState<NewsletterFormState>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(email: string, honeypot: string): Promise<void> {
    // Bot filled the hidden field: pretend it worked, do nothing.
    if (honeypot) {
      setState('success');
      return;
    }
    setState('submitting');
    setError(null);
    try {
      const res = await fetch('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, source }),
      });
      if (!res.ok) {
        setState('error');
        setError(
          res.status === 400
            ? 'Please enter a valid email address.'
            : 'Something went wrong. Please try again.'
        );
        return;
      }
      posthog.capture('newsletter_signup', { source, email_domain: emailDomain(email) });
      setState('success');
    } catch {
      setState('error');
      setError('Something went wrong. Please try again.');
    }
  }

  function reset(): void {
    setState('idle');
    setError(null);
  }

  return { state, error, submit, reset };
}
