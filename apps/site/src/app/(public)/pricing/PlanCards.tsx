'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PLANS, type Plan } from './pricing-data';

type Billing = 'monthly' | 'yearly';

/**
 * The plans, side by side, with one switch between monthly and yearly.
 *
 * The switch is the page's only client state. Everything a card says is in
 * `pricing-data.ts`, so the words and the numbers are edited in one place.
 */
export function PlanCards({ paidFrom }: { paidFrom: string }) {
  const [billing, setBilling] = useState<Billing>('monthly');

  return (
    <div className="flex flex-col items-center">
      <BillingSwitch value={billing} onChange={setBilling} />
      <ul className="mt-10 grid w-full gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => (
          <li key={plan.id} className="flex">
            <PlanCard plan={plan} billing={billing} paidFrom={paidFrom} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function BillingSwitch({ value, onChange }: { value: Billing; onChange: (b: Billing) => void }) {
  const options: { id: Billing; label: string }[] = [
    { id: 'monthly', label: 'Monthly' },
    { id: 'yearly', label: 'Yearly' },
  ];
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        role="group"
        aria-label="Billing period"
        className="bg-cream-secondary inline-flex rounded-full p-1"
      >
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              'rounded-full px-5 py-2 text-sm font-medium transition-colors',
              value === option.id
                ? 'bg-cream-white text-charcoal shadow-sm'
                : 'text-warm-gray hover:text-charcoal'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-warm-gray text-sm">Pay yearly and get two months free.</p>
    </div>
  );
}

function PlanCard({ plan, billing, paidFrom }: { plan: Plan; billing: Billing; paidFrom: string }) {
  const yearly = billing === 'yearly' && plan.yearly !== null;
  const amount = yearly ? plan.yearly : plan.monthly;
  const period = plan.monthly === 0 ? 'forever' : yearly ? 'a year' : 'a month';
  const dark = plan.highlighted;

  return (
    <article
      aria-labelledby={`plan-${plan.id}`}
      className={cn(
        'relative flex w-full flex-col rounded-2xl p-6 sm:p-7',
        dark
          ? 'bg-charcoal text-cream-white shadow-xl'
          : 'bg-cream-white text-charcoal border-charcoal/10 border'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={`plan-${plan.id}`} className="text-xl font-semibold">
          {plan.name}
        </h3>
        {dark ? (
          <span className="bg-brand-orange rounded-full px-2.5 py-0.5 text-xs font-semibold text-[#131110]">
            Recommended
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          'mt-2 text-sm sm:min-h-[3rem]',
          dark ? 'text-cream-tertiary' : 'text-warm-gray'
        )}
      >
        {plan.tagline}
      </p>

      <p className="mt-6 flex items-baseline gap-1.5">
        <span className="text-5xl font-semibold tracking-[-0.03em] tabular-nums">
          ${amount?.toLocaleString('en-US')}
        </span>
        <span className={cn('text-sm', dark ? 'text-cream-tertiary' : 'text-warm-gray')}>
          {plan.unit ? `${plan.unit} ` : ''}
          {period}
        </span>
      </p>
      <p className={cn('mt-1 h-5 text-xs', dark ? 'text-cream-tertiary' : 'text-warm-gray')}>
        {plan.monthly === 0 ? 'No account needed to run it' : `Starts ${paidFrom}`}
      </p>

      <Link
        href={plan.cta.href}
        className={cn(
          'mt-6 inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
          dark
            ? 'bg-brand-orange focus-visible:ring-cream-white focus-visible:ring-offset-charcoal text-[#131110] hover:bg-[#f06d1a]'
            : 'bg-charcoal text-cream-white focus-visible:ring-charcoal focus-visible:ring-offset-cream-white hover:bg-[#33302a]'
        )}
      >
        {plan.cta.label}
      </Link>

      <ul className="mt-7 space-y-3 text-sm">
        {plan.benefits.map((benefit) => (
          <li key={benefit} className="flex gap-2.5">
            <Check
              aria-hidden="true"
              className={cn(
                'mt-0.5 size-4 shrink-0',
                dark ? 'text-brand-orange' : 'text-brand-green'
              )}
            />
            <span className={dark ? 'text-cream-white' : 'text-charcoal'}>{benefit}</span>
          </li>
        ))}
      </ul>

      {plan.note ? (
        <p
          className={cn(
            'mt-auto pt-6 text-xs leading-relaxed',
            dark ? 'text-cream-tertiary' : 'text-warm-gray'
          )}
        >
          {plan.note}
        </p>
      ) : null}
    </article>
  );
}
