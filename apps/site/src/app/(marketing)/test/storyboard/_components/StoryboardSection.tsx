'use client';

import type { ReactNode } from 'react';

interface StoryboardSectionProps {
  step: string;
  title: string;
  description: string;
  children: ReactNode;
}

/** A titled block of the storyboard, in the site's light marketing chrome. */
export function StoryboardSection({ step, title, description, children }: StoryboardSectionProps) {
  return (
    <section className="border-border-warm border-t py-14 first:border-t-0">
      <p className="text-2xs text-brand-orange mb-3 font-mono tracking-[0.15em] uppercase">
        {step}
      </p>
      <h2 className="text-charcoal font-mono text-2xl font-bold tracking-tight sm:text-3xl">
        {title}
      </h2>
      <p className="text-warm-gray mt-3 max-w-2xl text-lg">{description}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}
