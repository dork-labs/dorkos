import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Cookie Policy',
  description: 'How we use cookies and similar technologies.',
};

export default function CookiePolicyPage() {
  return (
    <div className="container-narrow py-12">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Cookie Policy</h1>
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
          <h2 className="text-xl font-semibold">What Are Cookies</h2>
          <p className="text-muted-foreground leading-relaxed">
            Cookies are small text files that are stored on your device when you visit a website.
            They help the website remember your preferences and understand how you interact with the
            site. Cookies are widely used to make websites work efficiently and provide a better
            user experience.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">How We Use Cookies</h2>
          <p className="text-muted-foreground leading-relaxed">
            We use cookies and similar technologies for the following purposes:
          </p>

          <div className="space-y-6">
            <div className="space-y-3">
              <h3 className="text-lg font-medium">Essential Cookies</h3>
              <p className="text-muted-foreground leading-relaxed">
                These cookies are necessary for the website to function properly. They enable core
                functionality such as security, session management, and accessibility. You cannot
                opt out of these cookies as they are required for the site to work.
              </p>
              <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
                <li>Authentication and session management</li>
                <li>Security tokens and CSRF protection</li>
                <li>Cookie consent preferences</li>
              </ul>
            </div>

            <div className="space-y-3">
              <h3 className="text-lg font-medium">Functional Cookies</h3>
              <p className="text-muted-foreground leading-relaxed">
                These cookies enable enhanced functionality and personalization, such as remembering
                your preferences and settings.
              </p>
              <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
                <li>Theme preferences (light/dark mode)</li>
                <li>Language and region settings</li>
                <li>UI customization preferences</li>
              </ul>
            </div>

            <div className="space-y-3">
              <h3 className="text-lg font-medium">Analytics Cookies</h3>
              <p className="text-muted-foreground leading-relaxed">
                These cookies help us understand how visitors interact with our website by
                collecting and reporting information anonymously.
              </p>
              <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
                <li>Page visit statistics</li>
                <li>Traffic sources and user journeys</li>
                <li>Performance monitoring</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Managing Cookies</h2>
          <p className="text-muted-foreground leading-relaxed">
            When you first visit our website, you will be shown a cookie consent banner that allows
            you to accept or customize your cookie preferences. You can change your preferences at
            any time.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            You can also manage cookies through your browser settings. Most browsers allow you to:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>View what cookies are stored and delete them individually</li>
            <li>Block third-party cookies</li>
            <li>Block cookies from specific sites</li>
            <li>Block all cookies</li>
            <li>Delete all cookies when you close your browser</li>
          </ul>
          <p className="text-muted-foreground leading-relaxed">
            Please note that blocking or deleting cookies may affect your experience on our website
            and limit certain functionality.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Third-Party Cookies</h2>
          <p className="text-muted-foreground leading-relaxed">
            Some cookies on our website are set by third-party services. These may include:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>Analytics providers (e.g., Google Analytics)</li>
            <li>Authentication services</li>
            <li>Payment processors</li>
          </ul>
          <p className="text-muted-foreground leading-relaxed">
            We do not control these third-party cookies. Please refer to the respective privacy
            policies of these providers for more information.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Cookie Retention</h2>
          <p className="text-muted-foreground leading-relaxed">
            The length of time a cookie remains on your device depends on its type:
          </p>
          <ul className="text-muted-foreground ml-4 list-inside list-disc space-y-1">
            <li>
              <strong>Session cookies</strong> are deleted when you close your browser
            </li>
            <li>
              <strong>Persistent cookies</strong> remain until they expire or you delete them
            </li>
          </ul>
          <p className="text-muted-foreground leading-relaxed">
            Our consent preferences are stored for 12 months before we ask you to confirm them
            again.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Updates to This Policy</h2>
          <p className="text-muted-foreground leading-relaxed">
            We may update this Cookie Policy from time to time to reflect changes in our practices
            or for operational, legal, or regulatory reasons. We will notify you of any significant
            changes by posting the new policy on this page.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">More Information</h2>
          <p className="text-muted-foreground leading-relaxed">
            For more information about how we handle your personal data, please see our{' '}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
          <p className="text-muted-foreground leading-relaxed">
            If you have any questions about our use of cookies, please contact us at:
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
