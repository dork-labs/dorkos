import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Our privacy policy and how we handle your data.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="container-narrow py-12">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
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
          <h2 className="text-xl font-semibold">Introduction</h2>
          <p className="text-muted-foreground leading-relaxed">
            DorkOS (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is committed to protecting
            your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard
            your information when you use our service.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Information We Collect</h2>

          <div className="space-y-3">
            <h3 className="text-lg font-medium">Personal Information</h3>
            <p className="text-muted-foreground leading-relaxed">
              We may collect personal information that you voluntarily provide when using our
              service, including:
            </p>
            <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
              <li>Email address</li>
              <li>Name</li>
              <li>Account credentials</li>
            </ul>
          </div>

          <div className="space-y-3">
            <h3 className="text-lg font-medium">Automatically Collected Information</h3>
            <p className="text-muted-foreground leading-relaxed">
              When you access our service, we may automatically collect certain information,
              including:
            </p>
            <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
              <li>IP address</li>
              <li>Browser type and version</li>
              <li>Device information</li>
              <li>Usage data and analytics</li>
            </ul>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">How We Use Your Information</h2>
          <p className="text-muted-foreground leading-relaxed">
            We use the information we collect for various purposes, including:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>Providing and maintaining our service</li>
            <li>Notifying you about changes to our service</li>
            <li>Providing customer support</li>
            <li>Monitoring and analyzing usage patterns</li>
            <li>Detecting and preventing fraud or abuse</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Data Security</h2>
          <p className="text-muted-foreground leading-relaxed">
            We implement appropriate technical and organizational security measures to protect your
            personal information. However, no method of transmission over the Internet or electronic
            storage is 100% secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Third-Party Services</h2>
          <p className="text-muted-foreground leading-relaxed">
            Our service may contain links to third-party websites or services. We are not
            responsible for the privacy practices of these third parties. We encourage you to review
            their privacy policies before providing any personal information.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Cookies</h2>
          <p className="text-muted-foreground leading-relaxed">
            We use cookies and similar tracking technologies to enhance your experience on our
            service. You can configure your browser to refuse cookies, but this may limit some
            functionality.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Your Rights</h2>
          <p className="text-muted-foreground leading-relaxed">
            Depending on your location, you may have certain rights regarding your personal
            information, including:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>The right to access your personal information</li>
            <li>The right to correct inaccurate information</li>
            <li>The right to delete your personal information</li>
            <li>The right to restrict or object to processing</li>
            <li>The right to data portability</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Children&apos;s Privacy</h2>
          <p className="text-muted-foreground leading-relaxed">
            Our service is not intended for children under the age of 13. We do not knowingly
            collect personal information from children under 13. If we discover that a child under
            13 has provided us with personal information, we will delete it immediately.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Changes to This Policy</h2>
          <p className="text-muted-foreground leading-relaxed">
            We may update this Privacy Policy from time to time. We will notify you of any changes
            by posting the new Privacy Policy on this page and updating the &quot;Last updated&quot;
            date.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Contact Us</h2>
          <p className="text-muted-foreground leading-relaxed">
            If you have any questions about this Privacy Policy, please contact us at:
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
