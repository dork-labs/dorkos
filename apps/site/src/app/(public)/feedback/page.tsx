import type { Metadata } from 'next';

import { FeedbackForm } from '@/layers/shared/ui/feedback-form';

export const metadata: Metadata = {
  title: 'Send feedback',
  description: 'Tell the DorkOS team what works, what does not, and what you wish it did.',
};

export default function FeedbackPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Send feedback</h1>
          <p className="text-warm-gray text-lg leading-relaxed">
            Tell us what works, what does not, and what you wish DorkOS did. It goes straight to the
            team. We read every message.
          </p>
        </header>

        <FeedbackForm />

        <p className="text-warm-gray-light font-mono text-sm leading-relaxed">
          Prefer a public thread? You can also{' '}
          <a
            href="https://github.com/dork-labs/dorkos/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-orange hover:underline"
          >
            open a GitHub issue
          </a>
          .
        </p>
      </article>
    </main>
  );
}
