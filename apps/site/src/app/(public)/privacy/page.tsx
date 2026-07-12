import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'What DorkOS collects, what it never touches, and the choices you have.',
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Privacy Policy</h1>
          <p className="text-warm-gray text-lg">Last updated: July 12, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. When this page says &quot;we,&quot; that is who
            we mean.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              The DorkOS app runs on your own computer. Your code and your chats with the AI go
              straight to the model vendor you picked. We never see them.
            </li>
            <li>
              This website collects almost nothing: your email if you subscribe, plus your name and
              email if you choose to make an account. If you accept the cookie banner, we also count
              basic, anonymous page visits.
            </li>
            <li>
              We do not run ads, we do not sell your data, and we do not track you around the web.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Two different things: the app and the website
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is software you install and run on your own machine. This website, dorkos.ai, is
            where you read about it, sign up for the newsletter, and browse the Marketplace. They
            have different privacy stories, so we cover them one at a time.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The DorkOS app: it runs on your machine
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS runs on your own computer. Your sessions, your agent chats, and your code stay on
            your machine, in files you control. We do not have a copy.
          </p>
          <p className="text-warm-gray leading-relaxed">
            When an agent works, it sends your prompts and code to the AI vendor you chose, like
            Anthropic or OpenAI, using your own API key or login. That exchange is between you and
            them, under their privacy policy. DorkOS just passes it along and keeps nothing.
          </p>
          <p className="text-warm-gray leading-relaxed">
            The app sends us no usage data today. None. We are building an opt-in way to share
            anonymous usage stats so we can improve DorkOS, but it is not finished yet. When it
            ships, it will stay off until you turn it on, and we will update this page.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The website: what we collect
          </h2>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">
              If you subscribe to the newsletter
            </h3>
            <p className="text-warm-gray leading-relaxed">
              We ask for your email address and nothing else. We send one confirmation email, and
              you are only subscribed after you click the link inside it. We keep your email so we
              can send you release notes, about twice a month. One click unsubscribes you. Your
              email lives in our database and in Resend, the service that delivers the emails.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">If you create a DorkOS account</h3>
            <p className="text-warm-gray leading-relaxed">
              An account is optional. You only need one to link a device or use signed-in features.
            </p>
            <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
              <li>
                We collect your name, email, and password. Your password is stored scrambled
                (hashed), never as plain text. You can also sign in with GitHub or Google instead.
              </li>
              <li>
                While you are signed in, we keep a session. For security, that session record
                includes your IP address and browser type.
              </li>
              <li>
                If you link a device, we save its name, operating system, and DorkOS version so you
                can see and manage your linked devices.
              </li>
              <li>
                You can delete your account, and everything tied to it, any time from your account
                page.
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">
              When you install from the Marketplace
            </h3>
            <p className="text-warm-gray leading-relaxed">
              We count installs so we can show how popular a package is. We record the package name,
              whether the install worked, how long it took, and a random one-time ID.
            </p>
            <p className="text-warm-gray leading-relaxed">
              We do not record your name, IP address, username, computer name, or which folder you
              installed into. The count is anonymous, and we cannot tie it back to you.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">What about analytics and cookies?</h3>
            <p className="text-warm-gray leading-relaxed">
              We use PostHog, a privacy-friendly analytics tool, to understand how the website is
              used. Nothing is recorded until you accept the cookie banner: if you decline, or just
              ignore it, we capture nothing at all. You can change your mind any time by clearing
              the site&apos;s cookies.
            </p>
            <p className="text-warm-gray leading-relaxed">
              Here is what we count once you accept: page visits and a few clicks, like copying the
              install command. That is it. There is no session recording, we do not log what you
              type, we do not use tracking that follows you to other sites, and we honor your
              browser&apos;s Do Not Track setting, which switches analytics off even if you
              accepted.
            </p>
            <p className="text-warm-gray leading-relaxed">
              The cookies we set are the basic ones: a login cookie if you sign in, and a small
              cookie that remembers UI preferences like whether a sidebar is open. We do not use ad
              cookies, and we do not sell cookie data. Our{' '}
              <Link href="/cookies" className="text-charcoal hover:text-brand-orange underline">
                Cookie Policy
              </Link>{' '}
              has the full list.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">What we never do</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>We never sell your data.</li>
            <li>We never run ads.</li>
            <li>We never track you across other websites.</li>
            <li>We never read the code or chats inside your DorkOS app.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Your choices</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>Unsubscribe from any email with one click.</li>
            <li>Delete your account and its data from your account page.</li>
            <li>
              Email us to ask what we hold or to have it removed:{' '}
              <a
                href="mailto:hey@dorkos.ai"
                className="text-charcoal hover:text-brand-orange underline"
              >
                hey@dorkos.ai
              </a>
              .
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Kids</h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is a tool for developers. It is not meant for children under 13, and we do not
            knowingly collect their information.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">When this changes</h2>
          <p className="text-warm-gray leading-relaxed">
            When we update this page, we will change the date at the top. If it is a big change, we
            will say so clearly. No quiet edits.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Contact</h2>
          <p className="text-warm-gray leading-relaxed">
            Questions about your privacy? Email us at{' '}
            <a
              href="mailto:hey@dorkos.ai"
              className="text-charcoal hover:text-brand-orange underline"
            >
              hey@dorkos.ai
            </a>
            .
          </p>
        </section>
      </article>
    </main>
  );
}
