import type { Metadata } from 'next';
import Link from 'next/link';
import { company } from '@dorkos/shared/company';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';

const description =
  'Exactly what the anonymous DorkOS heartbeat sends, how to turn it off, and our anonymous-by-default promise.';

export const metadata: Metadata = {
  title: 'Telemetry',
  description,
  alternates: { canonical: '/telemetry', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Telemetry — DorkOS',
    description,
    url: '/telemetry',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({ title: 'Telemetry — DorkOS', description }),
};

const HEARTBEAT_PAYLOAD = `{
  "instanceId": "a1b2c3d4-e5f6-...",
  "dorkosVersion": "0.47.0",
  "os": "darwin-arm64",
  "runtimesConfigured": ["claude-code", "codex"],
  "tunnelEnabled": false,
  "cloudLinked": false,
  "counts": { "agents": 4, "tasks": 2, "relayAdapters": 1 }
}`;

export default function TelemetryPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Telemetry</h1>
          <p className="text-warm-gray text-lg">Last updated: November 21, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by {company.legalName}. It sends us no usage data unless you turn it on.
            If you choose to help, you can share a little anonymous data so we can see roughly how
            many people run it. It is anonymous, not personal: no prompts, no code, no file paths,
            no chat content, ever. This page shows the exact data, word for word, and how to switch
            it on or off.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              Three anonymous things you can switch on: a daily heartbeat, marketplace install
              counts, and a few named feature-usage events. All are off until you do.
            </li>
            <li>
              The first time you run DorkOS, it shows you a notice with the payload below. If you do
              nothing, nothing is ever sent.
            </li>
            <li>It is anonymous. No prompts, no code, no file paths, no chat content, ever.</li>
            <li>
              Turn it off any time: run <span className="font-mono">dorkos telemetry disable</span>,
              set <span className="font-mono">DO_NOT_TRACK=1</span>, or use the Privacy and Data tab
              in settings.
            </li>
            <li>
              Crash reports, AI run summaries, and linking analytics to your account are separate
              choices. Each stays off until you turn it on.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            What the heartbeat sends
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS sends one small message to dorkos.ai about once a day. This is how we can even
            roughly count how many people are actively running DorkOS. Here is the whole thing:
          </p>
          <pre className="border-warm-gray-light/30 text-charcoal overflow-x-auto rounded-xl border bg-black/[0.03] p-4 text-sm">
            <code>{HEARTBEAT_PAYLOAD}</code>
          </pre>
          <p className="text-warm-gray leading-relaxed">Field by field:</p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              <span className="text-charcoal font-mono">instanceId</span>: a random id created once
              on your computer and kept. Every channel and feedback use the same one, so we do not
              double-count you. It is not your name, and it is not tied to your account unless you
              link analytics to your account (below).
            </li>
            <li>
              <span className="text-charcoal font-mono">dorkosVersion</span>: which version of
              DorkOS you are running.
            </li>
            <li>
              <span className="text-charcoal font-mono">os</span>: your platform and chip type, like{' '}
              <span className="font-mono">darwin-arm64</span>. Not your hostname.
            </li>
            <li>
              <span className="text-charcoal font-mono">runtimesConfigured</span>: which agent
              runtimes you have turned on, like Claude Code or Codex.
            </li>
            <li>
              <span className="text-charcoal font-mono">tunnelEnabled</span>: whether you use the
              tunnel to reach DorkOS from your phone. True or false only.
            </li>
            <li>
              <span className="text-charcoal font-mono">cloudLinked</span>: whether this install is
              linked to a DorkOS account. True or false only.
            </li>
            <li>
              <span className="text-charcoal font-mono">counts</span>: rough totals of your agents,
              tasks, and chat connections. Just numbers, never their names or contents.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">What it never sends</h2>
          <p className="text-warm-gray leading-relaxed">
            The list above is the complete payload. It is enforced in code and in tests, so nothing
            can sneak in. In particular it never includes your prompts, your code, file paths, your
            hostname or username, IP address, or anything from your chats. This is what makes it
            anonymous rather than personal. If we ever want to add a field, we change this page
            first.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            We tell you before anything sends
          </h2>
          <p className="text-warm-gray leading-relaxed">
            The very first time DorkOS starts, it prints a plain notice in its log: what it could
            share, a link to this page, and how to turn it on. Nothing is sent on that run, or on
            any run, until you say yes. On top of that, the code holds every channel shut until the
            notice has actually been shown, so nothing can send before you have seen what it covers.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Marketplace installs</h2>
          <p className="text-warm-gray leading-relaxed">
            The install-count channel is off by default too. Turning it on helps us rank packages
            and spot broken installs. It follows the same no-PII rule and is documented in detail on
            the{' '}
            <Link
              href="/marketplace/privacy"
              className="text-charcoal hover:text-brand-orange underline"
            >
              marketplace privacy page
            </Link>
            .
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Feature-usage events</h2>
          <p className="text-warm-gray leading-relaxed">
            This channel is off by default too. Turn it on and DorkOS sends a short list of named
            events, so we can see which features get used and where people get stuck. Each one
            carries your random install id, a timestamp, and your DorkOS version, plus only the
            fields below:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              <span className="font-mono">app_started</span>, each time DorkOS starts: your platform
              and chip type, and how many agent runtimes you have on.
            </li>
            <li>
              <span className="font-mono">session_created</span>, when you start a new chat: which
              runtime runs it, like Claude Code.
            </li>
            <li>
              <span className="font-mono">first_run_completed</span>, once per install, after you
              finish or skip setup: the install tag, if your install command carried one.
            </li>
            <li>
              <span className="font-mono">instance_active</span>, at most once a day while DorkOS
              runs: nothing beyond the id, time, and version.
            </li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            The install tag comes from a command copied on dorkos.ai by a visitor who allowed
            analytics cookies, like <span className="font-mono">--ref=k3j4mnb8x2qa.hn.launch</span>.
            It is a random code made for that one copy, plus the campaign tag of the link that
            brought them, if any. It lets us count which copies led to an install that someone
            actually used, by matching the tag on the two events. Matching it ties that one copy to
            that one install. The tag on its own never merges the app with a website visitor or an
            account. DorkOS keeps it in <span className="font-mono">~/.dork/install-ref.json</span>{' '}
            and sends it only with <span className="font-mono">first_run_completed</span>, only when
            this channel is on.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Error reporting (a separate opt-in)
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS can also send a crash report when something breaks, so we can fix it without
            asking you to dig through log files. Unlike the heartbeat, this one is off until you
            turn it on, and it is careful about what it sends:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              It goes to <span className="text-charcoal font-semibold">dorkos.ai</span>, which
              passes it to PostHog Error Tracking, the service we use to group and read crash
              reports. There is nothing for you to set up.
            </li>
            <li>
              We send the error type and a cleaned-up stack trace (which function, which file, which
              line), and nothing else. We do{' '}
              <span className="text-charcoal font-semibold">not</span> send the error message text
              at all, because a message can contain whatever your code put in it. No prompts, no
              code, no file paths, no chat data.
            </li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            Before anything is sent, home directories and full file paths are stripped (so no
            username leaks), and anything that looks like a key, token, or password is redacted. To
            turn it on, use the Privacy and Data tab, run{' '}
            <span className="font-mono">dorkos telemetry enable --channel errors</span>, or set{' '}
            <span className="font-mono">telemetry.errorReporting: true</span> in your config. All
            three change the same setting. Leave it off (the default) and nothing is reported. You
            can preview a crash report first with{' '}
            <span className="font-mono">DORKOS_TELEMETRY_DEBUG=1</span>, which prints it to your
            terminal instead of sending it.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            AI run summaries (a separate opt-in)
          </h2>
          <p className="text-warm-gray leading-relaxed">
            When an agent finishes a turn, DorkOS can send one short summary: the model, the
            runtime, the input and output token counts, how long it took, and what it cost. It
            carries no prompt, no code, no file path, and nothing you or the agent said. It is off
            until you turn it on with <span className="font-mono">telemetry.aiMetadata: true</span>{' '}
            or the Privacy and Data tab.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Linking analytics to your account (a separate opt-in)
          </h2>
          <p className="text-warm-gray leading-relaxed">
            When you link DorkOS to a DorkOS account, a checkbox lets you tie this install’s usage
            data to that account. It is off by default and saved as{' '}
            <span className="font-mono">telemetry.linkAnalyticsToAccount</span>. If you tick it,
            DorkOS sends this install’s random id with the link request. Our analytics then treats
            your install, your account, and your signed-in visits to dorkos.ai (if you allow
            analytics cookies there) as one record. That record is no longer anonymous to us.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Where the data goes</h2>
          <p className="text-warm-gray leading-relaxed">
            Every channel sends to dorkos.ai. The heartbeat and install counts stay in our own
            database. Feature-usage events, crash reports, and AI run summaries are passed on to
            PostHog, the analytics service we use.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            How to turn it off (or back on)
          </h2>
          <p className="text-warm-gray leading-relaxed">
            You have three easy ways to turn the anonymous channels off, and any one of them is
            enough:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              Run <span className="font-mono">dorkos telemetry disable</span> from your terminal.
            </li>
            <li>
              Set the environment variable <span className="font-mono">DO_NOT_TRACK=1</span> (or{' '}
              <span className="font-mono">DORKOS_TELEMETRY_DISABLED=1</span>). This beats your
              config, so it turns every channel off at once. It also stops the update checks.
            </li>
            <li>
              Open settings and use the <span className="font-mono">Privacy and Data</span> tab,
              which has a switch for each channel.
            </li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            You can also edit your config file at{' '}
            <span className="font-mono">~/.dork/config.json</span>:
          </p>
          <pre className="border-warm-gray-light/30 text-charcoal overflow-x-auto rounded-xl border bg-black/[0.03] p-4 text-sm">
            <code>{`{
  "telemetry": {
    "heartbeat": false,       // the daily ping (off by default)
    "install": false,         // marketplace install counts (off by default)
    "usage": false,           // feature-usage events (off by default)
    "errorReporting": false,  // scrubbed crash reports (off by default)
    "aiMetadata": false,      // AI run summaries (off by default)
    "userHasDecided": true
  }
}`}</code>
          </pre>
          <p className="text-warm-gray leading-relaxed">
            Set a value to <span className="font-mono">true</span> to turn a channel on, or{' '}
            <span className="font-mono">false</span> to turn it off. Every channel defaults to{' '}
            <span className="font-mono">false</span>.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            What the off switches do not stop
          </h2>
          <p className="text-warm-gray leading-relaxed">
            A few requests are not telemetry, so the environment variables leave them alone:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              The Mac and Windows apps ask GitHub for updates when they open and every 4 hours. This
              has no switch; the <span className="font-mono">dorkos</span> command does not do it.
            </li>
            <li>
              A font you pick in settings, other than the default Inter or System default, loads
              from Google Fonts.
            </li>
            <li>
              A computer linked to a DorkOS account checks in every 15 minutes with its name,
              platform, and DorkOS version. Unlinking it stops this.
            </li>
            <li>Feedback goes out only when you press Send.</li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            The{' '}
            <Link
              href="/docs/self-hosting/telemetry"
              className="text-charcoal hover:text-brand-orange underline"
            >
              full telemetry guide
            </Link>{' '}
            has the details.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Preview the exact payload
          </h2>
          <p className="text-warm-gray leading-relaxed">
            Set <span className="font-mono">DORKOS_TELEMETRY_DEBUG=1</span> and DorkOS prints the
            exact JSON it would send to your terminal instead of sending it. Nothing goes over the
            network in that mode, so you can read, word for word, what would leave your machine.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Why anonymous by default
          </h2>
          <p className="text-warm-gray leading-relaxed">
            An anonymous count that cannot be traced to you is the norm for developer tools, from
            Next.js to VS Code to Homebrew, and it is the only way a small team can tell whether
            people are actually using what it builds. We keep it genuinely anonymous, we show you
            the whole payload, and we make turning it off a one-liner. Your code and your chats
            never reach us as telemetry. They go to the AI service your agents use, and to us only
            if you include them in feedback.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">When this changes</h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS moves fast. If what the heartbeat sends ever changes, we update this page and the
            date at the top before the change ships. No quiet edits.
          </p>
        </section>
      </article>
    </main>
  );
}
