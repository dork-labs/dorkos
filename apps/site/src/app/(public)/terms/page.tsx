import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'Terms and conditions for using our service.',
};

export default function TermsOfServicePage() {
  return (
    <div className="container-narrow py-12">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
          <p className="text-muted-foreground text-lg">
            Last updated:{' '}
            {new Date().toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Agreement to Terms</h2>
          <p className="text-muted-foreground leading-relaxed">
            By accessing or using our service, you agree to be bound by these Terms of Service
            (&quot;Terms&quot;). If you disagree with any part of these terms, you may not access
            the service.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Description of Service</h2>
          <p className="text-muted-foreground leading-relaxed">
            DorkOS provides a web-based interface for Claude Code, built with the Claude Agent SDK.
            We reserve the right to modify, suspend, or discontinue the service at any time without
            notice.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">User Accounts</h2>
          <p className="text-muted-foreground leading-relaxed">
            When you create an account with us, you must provide accurate and complete information.
            You are responsible for:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>Maintaining the confidentiality of your account credentials</li>
            <li>All activities that occur under your account</li>
            <li>Notifying us immediately of any unauthorized use</li>
          </ul>
          <p className="text-muted-foreground leading-relaxed">
            We reserve the right to suspend or terminate accounts that violate these Terms or for
            any other reason at our sole discretion.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Acceptable Use</h2>
          <p className="text-muted-foreground leading-relaxed">
            You agree not to use our service to:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>Violate any applicable laws or regulations</li>
            <li>Infringe on the rights of others</li>
            <li>Transmit harmful, offensive, or illegal content</li>
            <li>Attempt to gain unauthorized access to our systems</li>
            <li>Interfere with or disrupt the service</li>
            <li>Use automated systems to access the service without permission</li>
            <li>Collect or harvest user data without consent</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Intellectual Property</h2>
          <p className="text-muted-foreground leading-relaxed">
            The service and its original content, features, and functionality are owned by DorkOS
            and are protected by international copyright, trademark, patent, trade secret, and other
            intellectual property laws.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            You retain ownership of any content you submit to the service. By submitting content,
            you grant us a worldwide, non-exclusive, royalty-free license to use, reproduce, modify,
            and distribute that content in connection with the service.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">User Content</h2>
          <p className="text-muted-foreground leading-relaxed">
            You are solely responsible for any content you post, upload, or otherwise make available
            through our service. We do not endorse any user content and expressly disclaim any
            liability related to user content.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            We reserve the right to remove any content that violates these Terms or that we find
            objectionable for any reason.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Privacy</h2>
          <p className="text-muted-foreground leading-relaxed">
            Your use of the service is also governed by our{' '}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            , which is incorporated into these Terms by reference.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Disclaimers</h2>
          <p className="text-muted-foreground text-sm leading-relaxed uppercase">
            The service is provided &quot;as is&quot; and &quot;as available&quot; without
            warranties of any kind, either express or implied, including but not limited to implied
            warranties of merchantability, fitness for a particular purpose, and non-infringement.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            We do not warrant that the service will be uninterrupted, secure, or error-free, or that
            any defects will be corrected.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Limitation of Liability</h2>
          <p className="text-muted-foreground text-sm leading-relaxed uppercase">
            In no event shall DorkOS, its directors, employees, partners, agents, suppliers, or
            affiliates be liable for any indirect, incidental, special, consequential, or punitive
            damages, including without limitation, loss of profits, data, use, goodwill, or other
            intangible losses.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Indemnification</h2>
          <p className="text-muted-foreground leading-relaxed">
            You agree to defend, indemnify, and hold harmless DorkOS and its affiliates from any
            claims, damages, obligations, losses, liabilities, costs, or expenses arising from your
            use of the service or violation of these Terms.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Governing Law</h2>
          <p className="text-muted-foreground leading-relaxed">
            These Terms shall be governed by and construed in accordance with the laws of the State
            of California, without regard to its conflict of law provisions.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Changes to Terms</h2>
          <p className="text-muted-foreground leading-relaxed">
            We reserve the right to modify these Terms at any time. We will provide notice of
            significant changes by posting the new Terms on this page and updating the &quot;Last
            updated&quot; date.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            Your continued use of the service after any changes constitutes acceptance of the new
            Terms.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Termination</h2>
          <p className="text-muted-foreground leading-relaxed">
            We may terminate or suspend your access to the service immediately, without prior
            notice, for any reason, including breach of these Terms.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            Upon termination, your right to use the service will cease immediately. Provisions of
            these Terms that by their nature should survive termination shall survive.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Contact Us</h2>
          <p className="text-muted-foreground leading-relaxed">
            If you have any questions about these Terms, please contact us at:
          </p>
          <p className="text-muted-foreground">
            Email:{' '}
            <a href="mailto:hey@dorkos.ai" className="text-primary hover:underline">
              hey@dorkos.ai
            </a>
          </p>
        </section>
      </article>
    </div>
  );
}
