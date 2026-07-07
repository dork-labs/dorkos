'use client';

/**
 * Newsletter signup form (ADR 260707-025214).
 *
 * A single reusable capture surface rendered in three places (footer,
 * `/newsletter` page, end-of-blog CTA) via the `variant` prop. Double opt-in:
 * a successful submit only means "check your inbox" — the address is not on the
 * list until the emailed link is clicked. Honest cadence microcopy and a
 * honeypot field are always present.
 *
 * @module widgets/newsletter-signup/NewsletterSignupForm
 */
import { type FormEvent, useId, useState } from 'react';

import type { NewsletterSource } from '@/db/newsletter-schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { useNewsletterForm } from './use-newsletter-form';

/** Visual treatment. `compact` is for the dark footer; `card` for light surfaces. */
export type NewsletterVariant = 'compact' | 'card';

interface NewsletterSignupFormProps {
  /** Which capture surface this instance is (analytics + copy). */
  source: NewsletterSource;
  /** Visual treatment. Defaults to `card`. */
  variant?: NewsletterVariant;
  /** Optional extra classes on the root. */
  className?: string;
}

const CADENCE_COPY =
  'Release notes and fleet reports, about twice a month. One click to unsubscribe.';

/**
 * Render the newsletter signup form.
 *
 * @param props - Source, variant, and optional className.
 */
export function NewsletterSignupForm({
  source,
  variant = 'card',
  className,
}: NewsletterSignupFormProps) {
  const { state, error, submit } = useNewsletterForm(source);
  const [email, setEmail] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const emailId = useId();
  const honeypotId = useId();
  const isCompact = variant === 'compact';

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    await submit(email, honeypot);
  }

  if (state === 'success') {
    return (
      <div
        className={cn(
          'font-mono',
          isCompact ? 'text-2xs text-cream-tertiary' : 'text-warm-gray text-sm',
          className
        )}
        role="status"
      >
        <p className={cn('font-medium', isCompact ? 'text-cream-white' : 'text-charcoal')}>
          Almost there. Check your inbox.
        </p>
        <p className={cn('mt-1', isCompact ? 'text-cream-tertiary/70' : 'text-warm-gray-light')}>
          Click the link in the confirmation email to finish subscribing.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className={cn('w-full', className)} noValidate>
      <div
        className={cn('flex gap-2', isCompact ? 'flex-col sm:flex-row' : 'flex-col sm:flex-row')}
      >
        <label htmlFor={emailId} className="sr-only">
          Email address
        </label>
        <Input
          id={emailId}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={state === 'submitting'}
          aria-invalid={state === 'error'}
          className={cn(
            'flex-1',
            isCompact &&
              'border-cream-tertiary/20 text-cream-white placeholder:text-cream-tertiary/40 bg-white/5'
          )}
        />
        {/* Honeypot: hidden from humans, catches bots. */}
        <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
          <label htmlFor={honeypotId}>Leave this field empty</label>
          <input
            id={honeypotId}
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={state === 'submitting'} className="shrink-0">
          {state === 'submitting' ? 'Subscribing…' : 'Subscribe'}
        </Button>
      </div>
      {state === 'error' && error && (
        <p className="text-2xs mt-2 font-mono text-red-500" role="alert">
          {error}
        </p>
      )}
      <p
        className={cn(
          'mt-2 font-mono',
          isCompact ? 'text-2xs text-cream-tertiary/60' : 'text-warm-gray-light text-xs'
        )}
      >
        {CADENCE_COPY}
      </p>
    </form>
  );
}
