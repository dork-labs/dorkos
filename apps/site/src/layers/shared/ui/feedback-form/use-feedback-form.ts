'use client';

/**
 * Submit logic for the site feedback form (DOR-317, ADR 260713-143958 Phase 5).
 *
 * Owns a small idle → submitting → success | error state machine and posts a
 * single user-volunteered feedback event straight to the owned ingest
 * (`/api/telemetry/events`) with `surface: 'site'`. A honeypot value
 * short-circuits to a fake success so bots never learn they were caught.
 *
 * Feedback is a message the visitor chose to send, so it is NOT gated on
 * analytics consent — but its pseudonymous `distinctId` reuses PostHog's own
 * distinct id when analytics is active (so the team can correlate it with the
 * visitor's journey), falling back to a random UUID otherwise. Only what the
 * visitor typed (`message`, optional `contact`) leaves the browser.
 *
 * @module shared/ui/feedback-form/use-feedback-form
 */
import { useState } from 'react';

import { getAnalyticsDistinctId } from '@/lib/analytics';

/** The kind of feedback the form can send. `idea` maps to a feature request. */
export type FeedbackKind = 'feedback' | 'bug' | 'idea';

/** Form lifecycle state. */
export type FeedbackFormState = 'idle' | 'submitting' | 'success' | 'error';

/** What {@link useFeedbackForm} returns to the view. */
export interface UseFeedbackForm {
  /** Current lifecycle state. */
  state: FeedbackFormState;
  /** Human-readable error when `state === 'error'`. */
  error: string | null;
  /** Submit the form. `honeypot` is the bot-trap value (should be empty). */
  submit: (input: {
    kind: FeedbackKind;
    message: string;
    contact: string;
    honeypot: string;
  }) => Promise<void>;
}

/** Build the feedback event body posted to the ingest. */
function buildEventBody(input: {
  kind: FeedbackKind;
  message: string;
  contact: string;
  honeypot: string;
}): Record<string, unknown> {
  const contact = input.contact.trim();
  const route = typeof window !== 'undefined' ? window.location.pathname : undefined;
  const properties: Record<string, unknown> = {
    message: input.message.trim(),
    surface: 'site',
    ...(contact ? { contact } : {}),
    ...(route ? { route } : {}),
  };
  // `idea` becomes a feature request (no `kind`); the rest carry their kind.
  if (input.kind !== 'idea') properties.kind = input.kind;

  const event = {
    event: input.kind === 'idea' ? 'feature_requested' : 'feedback_submitted',
    properties,
    distinctId: getAnalyticsDistinctId() ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  // `website` is the honeypot: the ingest drops the whole batch when it is set.
  return { events: [event], website: input.honeypot };
}

/**
 * Hook powering the site feedback form.
 *
 * @returns The form state and a `submit` action.
 */
export function useFeedbackForm(): UseFeedbackForm {
  const [state, setState] = useState<FeedbackFormState>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(input: {
    kind: FeedbackKind;
    message: string;
    contact: string;
    honeypot: string;
  }): Promise<void> {
    // Bot filled the hidden field: pretend it worked, send nothing.
    if (input.honeypot) {
      setState('success');
      return;
    }
    if (!input.message.trim()) {
      setState('error');
      setError('Please write a message first.');
      return;
    }

    setState('submitting');
    setError(null);
    try {
      const res = await fetch('/api/telemetry/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildEventBody(input)),
      });
      if (!res.ok) {
        setState('error');
        setError('Something went wrong. Please try again.');
        return;
      }
      setState('success');
    } catch {
      setState('error');
      setError('Something went wrong. Please try again.');
    }
  }

  return { state, error, submit };
}
