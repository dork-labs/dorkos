import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import { PlanCards } from './PlanCards';
import {
  COMPARE,
  COMPARE_PLANS,
  ELIGIBILITY_NOTE,
  EXTRAS,
  LAST_UPDATED,
  MODEL_PRICES,
  NOTICE_DAYS,
  PAID_FROM,
  TAX_NOTE,
  TOP_UP_MIN_CREDITS,
  creditsInDollars,
  formatCredits,
  formatRate,
} from './pricing-data';

const DESCRIPTION =
  'DorkOS is free and open source. Pay only if you want the cloud: AI included, and your agents in reach from anywhere.';

export const metadata: Metadata = {
  title: 'Pricing',
  description: DESCRIPTION,
  alternates: { canonical: '/pricing', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Pricing — DorkOS',
    description: DESCRIPTION,
    url: '/pricing',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({ title: 'Pricing — DorkOS', description: DESCRIPTION }),
};

const LINK = 'text-charcoal hover:text-brand-orange underline underline-offset-2';

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 pt-28 pb-24 sm:px-6 sm:pt-36">
      <header className="mx-auto max-w-3xl text-center">
        <h1 className="text-charcoal text-[clamp(2.5rem,7vw,4.5rem)] leading-[1] font-semibold tracking-[-0.04em] text-balance">
          DorkOS is free.
          <br />
          The cloud is optional.
        </h1>
        <p className="text-warm-gray mx-auto mt-6 max-w-xl text-lg text-pretty sm:text-xl">
          DorkOS is open source and runs on your computer at no cost, forever. Pay only if you want
          AI included and your agents in reach from anywhere.
        </p>
      </header>

      <section aria-labelledby="plans-heading" className="mt-14 sm:mt-16">
        <h2 id="plans-heading" className="sr-only">
          Plans
        </h2>
        <PlanCards paidFrom={PAID_FROM} />
        <p className="text-warm-gray mt-6 text-center text-sm">
          Every price on this page applies from {PAID_FROM}. {TAX_NOTE}
        </p>
        <p className="text-warm-gray mx-auto mt-2 max-w-2xl text-center text-sm text-pretty">
          {ELIGIBILITY_NOTE}
        </p>
      </section>

      <section aria-labelledby="extras-heading" className="mx-auto mt-10 max-w-4xl">
        <h2 id="extras-heading" className="text-charcoal text-center text-base font-semibold">
          Extras
        </h2>
        <ul className="divide-charcoal/10 mt-4 grid divide-y text-sm sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {EXTRAS.map((extra) => (
            <li key={extra.name} className="px-2 py-3 text-center sm:px-6 sm:py-1">
              <p className="text-charcoal">
                <span className="font-medium">{extra.name}</span>{' '}
                <span className="text-warm-gray">{extra.price}</span>
              </p>
              <p className="text-warm-gray mt-1 text-pretty">{extra.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <AiUsage />

      <section className="mx-auto mt-24 max-w-3xl text-center">
        <p className="text-charcoal text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-3xl">
          Anything DorkOS ships as free stays free.
        </p>
        <p className="text-warm-gray mx-auto mt-4 max-w-xl text-pretty">
          Paid plans only add things that run on our servers. They are never carved out of the free
          app. We wrote that here so we cannot quietly change it later.
        </p>
      </section>

      <div className="mx-auto mt-20 max-w-4xl space-y-4">
        <Expander title="Compare every feature" id="compare">
          <CompareTable />
        </Expander>
        <Expander title="Questions" id="faq">
          <Faq />
        </Expander>
      </div>

      <footer className="text-warm-gray mx-auto mt-16 max-w-3xl text-center text-sm">
        <p>
          Questions?{' '}
          <a href="mailto:hey@dorkos.ai" className={LINK}>
            hey@dorkos.ai
          </a>
          . DorkOS is made by Blaze Ventures, LLC. See also{' '}
          <Link href="/security" className={LINK}>
            Security
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className={LINK}>
            Privacy
          </Link>
          .
        </p>
        <p className="mt-2">Last updated {LAST_UPDATED}</p>
      </footer>
    </main>
  );
}

/** How AI usage is paid for: three facts up front, the per-model prices one click down. */
function AiUsage() {
  const facts = [
    {
      title: 'Included every month',
      body: 'Every paid plan comes with AI credits. They refresh each month.',
    },
    {
      title: 'Add more any time',
      body: `From ${PAID_FROM}, buy credits any time: ${formatCredits(TOP_UP_MIN_CREDITS)} credits (${creditsInDollars(TOP_UP_MIN_CREDITS)}) or more. Credits you buy never expire.`,
    },
    {
      title: 'Or use your own',
      body: 'Already pay for an AI plan, like Claude? Use that account, and AI costs you nothing here.',
    },
  ];

  return (
    <section aria-labelledby="ai-heading" className="mx-auto mt-24 max-w-4xl sm:mt-28">
      <div className="text-center">
        <h2 id="ai-heading" className="text-charcoal text-3xl font-semibold tracking-[-0.03em]">
          How AI usage works
        </h2>
        <p className="text-warm-gray mx-auto mt-4 max-w-xl text-lg text-pretty">
          Your agents use AI as they work, and pay for it in credits. One credit is 1¢.
        </p>
      </div>

      <ul className="border-charcoal/10 bg-cream-white mt-10 grid rounded-2xl border sm:grid-cols-3">
        {facts.map((fact, i) => (
          <li
            key={fact.title}
            className={`p-6 ${i > 0 ? 'border-charcoal/10 border-t sm:border-t-0 sm:border-l' : ''}`}
          >
            <h3 className="text-charcoal text-base font-semibold">{fact.title}</h3>
            <p className="text-warm-gray mt-2 text-sm">{fact.body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <Expander title="See the price of each model" id="model-prices">
          <ModelPrices />
        </Expander>
      </div>
    </section>
  );
}

function ModelPrices() {
  return (
    <div className="space-y-5">
      <p className="text-warm-gray">
        AI models count what they read and write in tokens. A token is a small piece of a word. A
        million tokens is about 750,000 words. Prices are in credits per million tokens, with
        dollars beside them. One credit is 1¢.
      </p>
      <div className="border-charcoal/10 overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            DorkOS Cloud prices per model, in credits per million tokens, with dollars in brackets
          </caption>
          <thead>
            <tr className="border-charcoal/10 bg-cream-secondary border-b">
              <th scope="col" className="text-charcoal p-3 font-semibold sm:p-4">
                Model
              </th>
              <th scope="col" className="text-charcoal p-3 font-semibold sm:p-4">
                Reading
              </th>
              <th scope="col" className="text-charcoal p-3 font-semibold sm:p-4">
                Writing
              </th>
              <th scope="col" className="text-charcoal p-3 font-semibold sm:p-4">
                Rereading
              </th>
              <th scope="col" className="text-charcoal p-3 font-semibold sm:p-4">
                Saving to reread
              </th>
            </tr>
          </thead>
          <tbody>
            {MODEL_PRICES.map((model) => (
              <tr key={model.name} className="border-charcoal/10 border-b last:border-0">
                <th scope="row" className="p-3 align-top font-normal sm:p-4">
                  <span className="text-charcoal block font-medium">{model.name}</span>
                </th>
                {[model.input, model.output, model.cacheRead, model.cacheWrite].map(
                  (credits, i) => (
                    <td
                      key={i}
                      className="text-warm-gray p-3 align-top whitespace-nowrap tabular-nums sm:p-4"
                    >
                      {formatRate(credits)}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="text-warm-gray grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-charcoal font-medium">Reading</dt>
          <dd>Everything your agent gives the model: your message, its instructions, its files.</dd>
        </div>
        <div>
          <dt className="text-charcoal font-medium">Writing</dt>
          <dd>The model’s reply, including the thinking it does first.</dd>
        </div>
        <div>
          <dt className="text-charcoal font-medium">Rereading</dt>
          <dd>
            Text the model read a moment ago in the same conversation. It costs a tenth or less of
            reading, and it is most of what a long agent run uses.
          </dd>
        </div>
        <div>
          <dt className="text-charcoal font-medium">Saving to reread</dt>
          <dd>Storing text the first time, so later steps can reread it cheaply.</dd>
        </div>
      </dl>
      <div className="border-charcoal/10 space-y-2 border-t pt-5">
        <h3 className="text-charcoal text-base font-semibold">What does that add up to?</h3>
        <p className="text-warm-gray">
          It depends on the model and the work, so treat this as a rough guide. When we measured our
          own agents over a month, one agent working steadily for an hour on Claude Sonnet 5 came to
          about 1,000 to 2,000 credits ($10 to $20) at these prices. A busy hour came to 3,000 or
          more. Each agent you run at the same time adds its own. Our use is heavy: long sessions on
          large projects. Lighter work costs less. Opus and Fable cost more.
        </p>
      </div>
      <p className="text-warm-gray text-sm">
        Model prices follow the prices set by Anthropic, the company that makes Claude. When theirs
        go down, ours do too, with the same {NOTICE_DAYS}-day notice. Claude Opus 5.5 is the Opus we
        recommend.
      </p>
    </div>
  );
}

function CompareTable() {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <caption className="sr-only">Every feature, by plan</caption>
        <thead>
          <tr className="border-charcoal/15 border-b">
            <td className="p-3" />
            {COMPARE_PLANS.map((name) => (
              <th key={name} scope="col" className="text-charcoal p-3 font-semibold">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        {COMPARE.map((group) => (
          <tbody key={group.heading}>
            <tr>
              <th
                scope="colgroup"
                colSpan={COMPARE_PLANS.length + 1}
                className="text-charcoal pt-6 pb-2 pl-3 text-xs font-semibold"
              >
                {group.heading}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.label} className="border-charcoal/10 border-t">
                <th scope="row" className="w-[26%] p-3 align-top font-normal">
                  <span className="text-charcoal block">{row.label}</span>
                  {row.hint ? (
                    <span className="text-warm-gray block text-xs">{row.hint}</span>
                  ) : null}
                </th>
                {row.cells.map((cell, i) => (
                  <td key={COMPARE_PLANS[i]} className="text-warm-gray p-3 align-top">
                    {cell === '—' ? (
                      <>
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">Not included</span>
                      </>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function Faq() {
  const items: { q: string; a: ReactNode }[] = [
    {
      q: 'Is DorkOS really free?',
      a: 'Yes. DorkOS is open source. Everything it does on your computer is free, with no time limit and no account. Paid plans only add things that run on our servers.',
    },
    {
      q: 'Do I need a plan to use AI?',
      a: 'No. Use your own AI account and you pay us nothing for AI. A plan is simpler: AI credits are included, on one bill.',
    },
    {
      q: 'What happens if I run out of credits?',
      a: 'Your agents finish the step they are on, then pause. If that step goes past zero, the difference comes out of the next credits you get. It is never billed to your card. To carry on, buy more credits, wait for your plan’s next month, or switch to your own AI account.',
    },
    {
      q: 'I use my own Claude account. What if it hits its limit?',
      a: 'If your Claude plan hits its limit in the middle of a run, your agents can carry on using credits you already have. You can turn this off. They never buy credits for you.',
    },
    {
      q: 'Do unused credits roll over?',
      a: 'Your plan’s monthly credits refresh each month and do not carry over. We always use them before credits you bought. Credits you buy never expire, even if you cancel.',
    },
    {
      q: 'How does paying yearly work?',
      a: 'You pay for ten months and get twelve. Your credits still arrive each month. Your price stays the same until your year ends.',
    },
    {
      q: 'Can prices change?',
      a: `Yes, but never by surprise. We post any change here, with the reason, at least ${NOTICE_DAYS} days before it takes effect. If you pay yearly, your price holds until your year ends. A credit you buy is always worth 1¢ of use at our posted prices. It never expires and never loses value.`,
    },
    {
      q: 'Is tax included?',
      a: TAX_NOTE,
    },
    {
      q: 'Who can buy a plan?',
      a: ELIGIBILITY_NOTE,
    },
    {
      q: 'What if I cancel?',
      a: 'You move to Free when the time you paid for ends. Nothing on your computer is deleted or switched off. Credits you bought stay yours.',
    },
    {
      q: 'Can I get a refund?',
      a: 'Payments aren’t refundable, except where the law requires it.',
    },
  ];

  return (
    <dl className="divide-charcoal/10 divide-y">
      {items.map((item) => (
        <div key={item.q} className="py-4 first:pt-0 last:pb-0">
          <dt className="text-charcoal font-medium">{item.q}</dt>
          <dd className="text-warm-gray mt-1.5 text-pretty">{item.a}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A native disclosure: closed by default, keyboard-ready, and found by the browser's find-in-page. */
function Expander({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <details
      id={id}
      className="group border-charcoal/10 bg-cream-white scroll-mt-32 rounded-2xl border"
    >
      <summary className="text-charcoal flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 font-medium select-none sm:px-6 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown
          aria-hidden="true"
          className="text-warm-gray size-5 shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="px-5 pb-6 sm:px-6">{children}</div>
    </details>
  );
}
