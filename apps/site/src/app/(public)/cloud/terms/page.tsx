import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { company, formatCompanyAddress } from '@dorkos/shared/company';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';

/*
 * The legal text below is the approved DorkOS Cloud terms, published as
 * written (DOR-2556). Only the company's name, address, governing state and
 * support address are filled in, and they come from `@dorkos/shared/company`,
 * never typed here. Change the wording only with the operator's approval.
 */

const description = 'The terms for DorkOS Cloud, the paid services we run for you.';

/** The date shown at the top; the terms promise every change is posted with its date. */
const LAST_UPDATED = 'October 14, 2026';

/** The address questions about these terms go to. */
const SUPPORT_EMAIL = company.emails.support;

export const metadata: Metadata = {
  title: 'Terms for DorkOS Cloud',
  description,
  alternates: { canonical: '/cloud/terms', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Terms for DorkOS Cloud — DorkOS',
    description,
    url: '/cloud/terms',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({ title: 'Terms for DorkOS Cloud — DorkOS', description }),
};

const LINK = 'text-charcoal hover:text-brand-orange underline';

/** One titled part of the terms. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-charcoal font-mono text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A paragraph of the terms. */
function P({ children }: { children: ReactNode }) {
  return <p className="text-warm-gray leading-relaxed">{children}</p>;
}

export default function CloudTermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Terms for DorkOS Cloud</h1>
          <p className="text-warm-gray text-lg">Last updated: {LAST_UPDATED}</p>
          <p className="text-warm-gray leading-relaxed">
            For the website, the newsletter and the Marketplace listing, see the{' '}
            <Link href="/terms" className={LINK}>
              Terms of Service
            </Link>
            .
          </p>
        </header>

        <P>
          DorkOS is made by {company.legalName}. When these terms say “we”, that is who you are
          agreeing with. They cover <strong>DorkOS Cloud</strong>: the services we run for you on
          our own servers when you have a DorkOS Cloud account, such as credits for AI models, a
          managed remote address, managed connections to other services, and hosted communities on
          Spaces. The DorkOS software itself is open source, and its license, not these terms,
          governs the code.
        </P>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              DorkOS Cloud is provided <strong>as is</strong>. We run it carefully, but we do not
              promise it will always be up, fast or free of errors.
            </li>
            <li>
              <strong>You are responsible</strong> for your account, your agents and what you and
              your members do with the services.
            </li>
            <li>
              <strong>Our liability is limited</strong> to what you paid us in the last 12 months,
              or US$50 if you paid nothing.
            </li>
            <li>
              <strong>You must be 18 or older and in the United States.</strong> DorkOS Cloud is for
              US customers.
            </li>
            <li>
              <strong>No refunds</strong>, except where the law requires one.
            </li>
          </ul>
        </section>

        <Section title="Who can use DorkOS Cloud">
          <P>
            You must be <strong>18 or older</strong> to have a DorkOS Cloud account. If you use it
            for an organization, you confirm you may bind that organization to these terms.
          </P>
          <P>
            <strong>DorkOS Cloud is for customers in the United States.</strong> You can open a paid
            account, buy credits or subscribe only if you, or the organization you act for, are
            located in the United States. We do not offer DorkOS Cloud to new customers in the
            European Union, the European Economic Area, the United Kingdom or Switzerland. The same
            goes for hosted communities: you can create or pay for a community on Spaces only as an
            owner in the United States, and the hosting terms for DorkOS communities say what
            happens if we find an owner is elsewhere. The free, open-source DorkOS app and anything
            you host yourself are not DorkOS Cloud and stay available everywhere.
          </P>
          <P>
            <strong>No use from sanctioned places or by sanctioned people.</strong> You may not use
            DorkOS Cloud from a country or region under a comprehensive US embargo, or if you are on
            a US sanctions or export-restriction list, or act for someone who is. We may end your
            account if we find you are.
          </P>
        </Section>

        <Section title="Your account and your responsibilities">
          <P>
            Keep your sign-in safe. You are responsible for what happens under your account,
            including what your agents do with DorkOS Cloud, what you and the members of your
            communities post, and the instructions you give us. You follow the acceptable-use rules
            for each service and the law.
          </P>
          <P>
            To the extent permitted by law, you will defend and indemnify {company.legalName}{' '}
            against claims, losses and costs, including reasonable legal fees, that arise from your
            use of DorkOS Cloud, your content, your agents, the members of your communities, your
            instructions to us, or your breach of these terms or the law.
          </P>
        </Section>

        <Section title="Payment and refunds">
          <P>
            Prices are on the{' '}
            <Link href="/pricing" className={LINK}>
              pricing page
            </Link>
            , and changes to them follow the price-change policy published there.{' '}
            <strong>We do not give refunds, except where the law requires one.</strong>
          </P>
        </Section>

        <Section title="What we may do">
          <P>
            We may remove content, suspend a service or an account, or end a service, at our
            discretion, when it breaks these terms or the acceptable-use rules or puts us at legal
            risk. We give notice where the law requires it. We may change or stop offering any part
            of DorkOS Cloud; where a change is worse for a paid account, the notice rule under
            “Changes to these terms” applies.
          </P>
        </Section>

        <Section title="Legal terms">
          <P>These apply to the extent permitted by law.</P>
          <ul className="text-warm-gray ml-5 list-disc space-y-3 leading-relaxed">
            <li>
              <strong>As is.</strong> DorkOS Cloud is provided “as is” and “as available”. We
              disclaim every warranty, express or implied, including merchantability, fitness for a
              particular purpose, non-infringement, and that the services will be uninterrupted,
              secure or free of errors or data loss. There is no service level. Keep your own copy
              of anything you cannot afford to lose.
            </li>
            <li>
              <strong>Limit of liability.</strong> Our total liability for everything arising out of
              or in connection with DorkOS Cloud and these terms is limited to the fees you paid us
              for DorkOS Cloud in the 12 months before the event that gave rise to the claim, or
              US$50 if you paid nothing. We are not liable for any indirect, incidental, special,
              consequential or punitive damages, or for lost profits, revenue, goodwill or data.
              Nothing here limits a liability the law does not allow to be limited.
            </li>
            <li>
              <strong>Things beyond our control.</strong> We are not responsible for a failure or
              delay caused by events beyond our reasonable control, including a failure of our
              suppliers, the internet, power, or an act of a government.
            </li>
            <li>
              <strong>Law and courts.</strong> These terms are governed by the law of{' '}
              {company.governingState}, without regard to its conflict-of-law rules. Any dispute is
              decided only by the state and federal courts located there, and you and we agree to
              their jurisdiction.
            </li>
            <li>
              <strong>No class actions.</strong> Each of us brings a claim only on our own behalf,
              not as a member of a class or in a representative action.
            </li>
            <li>
              <strong>One year to bring a claim.</strong> A claim about DorkOS Cloud or these terms
              must be brought within one year after it arises, or it is barred.
            </li>
            <li>
              <strong>The whole agreement.</strong> These terms, together with the terms for each
              service (the hosting terms for DorkOS communities, the acceptable-use pages, the
              privacy notices and, for an organization that signed one, the data processing
              agreement), are the whole agreement about DorkOS Cloud. Where a service’s own terms
              say more about that service, they apply to it. If a part of these terms cannot be
              enforced, the rest still applies.
            </li>
          </ul>
        </Section>

        <Section title="Changes to these terms">
          <P>
            We may change these terms. We post each change with its date. A change that is worse for
            a paid account takes effect <strong>30 days</strong> after we post it and email the
            account; any other change takes effect when posted. Using DorkOS Cloud after a change
            takes effect means you accept it.
          </P>
        </Section>

        <Section title="Questions">
          <P>
            Write to{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
              <strong>{SUPPORT_EMAIL}</strong>
            </a>
            . A person reads it, and we aim to reply within 2 business days.
          </P>
          <P>
            {company.legalName}, {formatCompanyAddress()}.
          </P>
        </Section>
      </article>
    </main>
  );
}
