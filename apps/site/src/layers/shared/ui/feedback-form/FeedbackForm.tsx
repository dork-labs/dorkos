'use client';

/**
 * Site feedback form (DOR-317, ADR 260713-143958 Phase 5).
 *
 * A small, accessible form that sends a message straight to the DorkOS team:
 * general feedback, a bug, or a feature idea. It is not telemetry — nothing is
 * sent until the visitor presses Send. A hidden honeypot field traps bots.
 *
 * @module shared/ui/feedback-form/FeedbackForm
 */
import { type FormEvent, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { type FeedbackKind, useFeedbackForm } from './use-feedback-form';

const KINDS: { value: FeedbackKind; label: string }[] = [
  { value: 'feedback', label: 'Feedback' },
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
];

const PLACEHOLDER: Record<FeedbackKind, string> = {
  feedback: 'What works, what does not, what you wish it did.',
  bug: 'What happened, and what did you expect instead?',
  idea: 'What would you like DorkOS to do?',
};

/** Render the site feedback form. */
export function FeedbackForm() {
  const { state, error, submit } = useFeedbackForm();
  const [kind, setKind] = useState<FeedbackKind>('feedback');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const messageId = useId();
  const contactId = useId();
  const honeypotId = useId();

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    await submit({ kind, message, contact, honeypot });
  }

  if (state === 'success') {
    return (
      <div className="border-warm-gray-light/30 rounded-xl border p-6" role="status">
        <p className="text-charcoal font-mono font-medium">Thanks, sent.</p>
        <p className="text-warm-gray mt-1 leading-relaxed">
          We read every message. If you left a contact, we may follow up.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {/* Kind selector */}
      <div role="radiogroup" aria-label="What kind of feedback" className="flex flex-wrap gap-2">
        {KINDS.map(({ value, label }) => {
          const selected = kind === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setKind(value)}
              className={cn(
                'rounded-lg border px-4 py-2 font-mono text-sm transition-colors',
                selected
                  ? 'border-brand-orange bg-brand-orange/10 text-charcoal'
                  : 'border-warm-gray-light/40 text-warm-gray hover:border-warm-gray-light'
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Message */}
      <div className="space-y-1.5">
        <label htmlFor={messageId} className="text-charcoal font-mono text-sm font-medium">
          Your message
        </label>
        <Textarea
          id={messageId}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={PLACEHOLDER[kind]}
          rows={6}
          required
          maxLength={4000}
          aria-invalid={state === 'error'}
        />
      </div>

      {/* Optional contact */}
      <div className="space-y-1.5">
        <label htmlFor={contactId} className="text-warm-gray font-mono text-sm">
          Contact (optional)
        </label>
        <Input
          id={contactId}
          type="text"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="Email or handle, if you'd like a reply"
          maxLength={254}
          autoComplete="off"
        />
      </div>

      {/* Honeypot: hidden from humans, catches bots. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor={honeypotId}>Leave this field empty</label>
        <input
          id={honeypotId}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      {state === 'error' && error && (
        <p className="font-mono text-sm text-red-500" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" disabled={state === 'submitting'}>
        {state === 'submitting' ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}
