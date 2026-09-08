import type { Metadata } from 'next';
import Link from 'next/link';
import { AnalyticsPreferenceControl } from '@/layers/widgets/cookie-consent';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';

const description = 'How DorkOS handles your information and the choices you have.';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description,
  alternates: { canonical: '/privacy', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Privacy Policy — DorkOS',
    description,
    url: '/privacy',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({ title: 'Privacy Policy — DorkOS', description }),
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Privacy Policy</h1>
          <p className="text-warm-gray text-lg">Last updated: September 7, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. When this page says “we,” that is who we mean.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              The DorkOS app runs on your computer. Agents send information to the AI services you
              choose. Optional DorkOS-managed connections also send account actions and selected
              notifications through our servers and Composio. You choose which accounts and agents
              can use them.
            </li>
            <li>
              This website collects almost nothing: your email if you subscribe, plus your name and
              email if you choose to make an account. We also count basic page visits. In the EU and
              UK we ask first with a banner. Everywhere else it is on by default, and you can switch
              it off in one click below. Either way, if you say no we still count you, but
              anonymously, with no cookies.
            </li>
            <li>
              We do not run ads, we do not sell your data, and we do not track you around the web.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The app, website, and hosted services
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS includes an app you run, this website, and optional hosted services. Each handles
            different information. Connecting an account or turning on notifications can send
            information beyond your computer, as explained below.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The DorkOS app: it runs on your machine
          </h2>
          <p className="text-warm-gray leading-relaxed">
            Your installation keeps local files, settings, and session records on your computer. An
            agent sends prompts, code, and other information it needs to the AI service you choose.
            That service handles the information under its own terms and privacy policy.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Information from connected accounts can become part of an agent’s work. For example, an
            email result may be sent to your chosen AI service. A notification sent to a room or
            messaging channel can be visible to other people there. Choose accounts, agents, and
            destinations with this in mind.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Optional usage telemetry is separate from the information needed to run hosted features.
            The settings below control telemetry. They do not disable account access or a
            notification you enabled. If you choose to help, the app can share a small daily
            heartbeat and anonymous marketplace install counts so we can see roughly how many people
            run DorkOS. It sends a random install id, the DorkOS version, your platform and chip
            type, which runtimes you have on, whether the tunnel and cloud link are enabled, and
            rough counts. It never sends your prompts, code, file paths, hostname, username, or
            session content as telemetry.
          </p>
          <p className="text-warm-gray leading-relaxed">
            The first time you run DorkOS, it shows a notice explaining this and sends nothing on
            that first run. You can turn it off any time in three ways: run{' '}
            <span className="font-mono">dorkos telemetry disable</span>, set the environment
            variable <span className="font-mono">DO_NOT_TRACK=1</span>, or use the Privacy and Data
            tab in settings. Crash reporting is a separate choice and stays off until you turn it
            on. The{' '}
            <Link href="/telemetry" className="text-charcoal hover:text-brand-orange underline">
              telemetry page
            </Link>{' '}
            shows the exact payload, word for word.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Optional DorkOS-managed connections
          </h2>
          <p className="text-warm-gray leading-relaxed">
            You can choose DorkOS-managed access when connecting a supported service. DorkOS uses
            Composio to link your service account and carry out approved actions. Composio holds the
            service account’s login access in its vault. Our servers hold the project key used to
            make those requests. Agents do not receive those credentials.
          </p>
          <p className="text-warm-gray leading-relaxed">
            When an agent uses this access, the action’s inputs pass through our servers and
            Composio to the connected service. The result returns through the same path. Inputs and
            results can include email text, documents, task details, or other information needed for
            that action.
          </p>
          <p className="text-warm-gray leading-relaxed">
            We store records needed to connect the right account and enforce your choices. These
            include your DorkOS account and linked installation, connected service references, agent
            access, and notification settings. We also record action names, request identifiers,
            status, timing, and usage information. Action receipts do not store an action’s input or
            result content.
          </p>
          <p className="text-warm-gray leading-relaxed">
            You choose which agents can perform approved actions. Receiving notifications requires a
            separate choice of activity and destination. Granting action access does not also grant
            notification access.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Notification content and retention
          </h2>
          <p className="text-warm-gray leading-relaxed">
            For managed notifications, Composio sends selected account activity to our servers. We
            keep an encrypted delivery copy so your linked installation can collect it later. Our
            service can decrypt that copy to deliver it. This encryption does not hide the content
            from DorkOS.
          </p>
          <p className="text-warm-gray leading-relaxed">
            The delivery window ends seven days after our servers receive the event. Retries and
            transfer to your installation do not restart that window. We clear the hosted content
            sooner when your installation confirms it has stored the event. That confirmation does
            not mean an agent has acted on it or a person has read it.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Your installation keeps its own protected delivery copy until delivery is recorded,
            cancelled, or the original window ends. Clearing a delivery copy does not erase a
            message already delivered to an agent, room, messaging service, or AI service.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Scheduled cleanup clears expired content in bounded batches, so an outage or backlog can
            delay physical deletion. Expired content cannot start a new delivery. We keep separate
            event identifiers and delivery status for a 30-day cleanup window to prevent duplicate
            processing.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Using your own service account
          </h2>
          <p className="text-warm-gray leading-relaxed">
            If you use your own Composio project, your installation contacts Composio directly.
            DorkOS hosting does not carry those account actions or buffer those direct
            notifications. Composio and the connected service still handle the information. Your
            local setup holds the project key and notification signing secret.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Other service routes can have different data paths. Review their setup and the service’s
            privacy policy before granting access. Ordinary Slack and Telegram conversations use
            your Messaging setup; account notifications have separate permissions.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Stopping access and deleting data
          </h2>
          <p className="text-warm-gray leading-relaxed">
            You can remove an agent’s access, remove a notification, or disconnect an account in the
            app. These choices stop new authorized use once the relevant change takes effect. An
            installation that is offline may need to reconnect to receive a hosted permission
            change. A request already sent to another service cannot be recalled.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Disconnecting asks Composio to remove the linked account. Cleanup can remain pending if
            a service is unavailable or the required access has been revoked. Removing one
            notification does not remove another notification that shares the same service setup.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Removing access does not erase every record. DorkOS can retain account history, usage
            records, security records, and temporary delivery records. It does not erase messages
            already delivered or records held by Composio, your connected service, or your AI
            service. Use those services’ controls for their records.
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
                If analytics is on and you are signed in, we tie your website activity to a random
                account ID (never your name or email) so we can see how signed-in people use DorkOS.
                If analytics is off, we do not.
              </li>
              <li>
                You can delete your account from your account page. This removes the account and its
                active hosted account-access data. Required security and audit records, temporary
                cleanup records, and records held by other services can remain. We also ask PostHog
                to erase the analytics record tied to your account.
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
              used. We count page visits and a few clicks, like copying the install command. That is
              it. There is no session recording, we do not log what you type, and we do not use
              tracking that follows you to other sites.
            </p>
            <p className="text-warm-gray leading-relaxed">
              How we ask depends on where you are. In the EU, the EEA, the UK, and Switzerland, we
              show a banner and count nothing with cookies until you accept. Everywhere else,
              analytics is on by default, and you can turn it off with the switch below or from the
              banner if you see one.
            </p>
            <p className="text-warm-gray leading-relaxed">
              Here is the honest part: if you decline, ignore the banner, or turn analytics off, we
              still count your visit, but anonymously. No cookies, no stored ID, and no way to
              connect today’s visit to tomorrow’s. We use a privacy-preserving code that is
              reshuffled every day, so the count cannot be traced back to you. We also honor your
              browser’s Do Not Track and Global Privacy Control signals: if either is on, the cookie
              version stays off automatically.
            </p>

            <AnalyticsPreferenceControl />

            <p className="text-warm-gray leading-relaxed">
              The cookies we set are the basic ones: a login cookie if you sign in, a small cookie
              that remembers UI preferences like whether a sidebar is open, and the analytics cookie
              only if you have it on. We do not use ad cookies, and we do not sell cookie data. Our{' '}
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
            <li>
              Your installation does not upload its whole session history or codebase to us for
              managed connections. Our hosted service processes the action and notification content
              described above when you use it.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Other services</h2>
          <p className="text-warm-gray leading-relaxed">
            Composio, each connected service, and the AI service you choose have their own terms and
            privacy practices. Their retention, deletion, and model-training rules can differ. This
            policy does not promise that another service deletes its logs or never uses data for
            training.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Your choices</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>Turn cookie-based analytics off (or on) with the switch above, any time.</li>
            <li>Unsubscribe from any email with one click.</li>
            <li>
              Delete your account from your account page, subject to the retention limits above.
            </li>
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
