import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Telemetry',
  description:
    'Exactly what the anonymous DorkOS heartbeat sends, how to turn it off, and our anonymous-by-default promise.',
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
          <p className="text-warm-gray text-lg">Last updated: July 13, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. It shares a little anonymous data by default so
            we can see roughly how many people run it. It is anonymous, not personal: no prompts, no
            code, no file paths, no session content, ever. This page shows the exact data, word for
            word, and every way to turn it off.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              Two anonymous things are on by default: a daily heartbeat and marketplace install
              counts.
            </li>
            <li>
              The first time you run DorkOS, it shows you a notice with the payload below and sends
              nothing on that first run.
            </li>
            <li>It is anonymous. No prompts, no code, no file paths, no session content, ever.</li>
            <li>
              Turn it off any time: run <span className="font-mono">dorkos telemetry disable</span>,
              set <span className="font-mono">DO_NOT_TRACK=1</span>, or use the Privacy and Data tab
              in settings.
            </li>
            <li>Crash reporting is separate and stays off until you turn it on.</li>
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
              <span className="text-charcoal font-mono">instanceId</span>: a random id created on
              your machine. It marks one install so we do not double-count you. It is not your name,
              your account, or anything we can trace back to you.
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
              tasks, and relay adapters. Just numbers, never their names or contents.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">What it never sends</h2>
          <p className="text-warm-gray leading-relaxed">
            The list above is the complete payload. It is enforced in code and in tests, so nothing
            can sneak in. In particular it never includes your prompts, your code, file paths, your
            hostname or username, IP address, or anything from your sessions. This is what makes it
            anonymous rather than personal, and it is why we can turn it on by default. If we ever
            want to add a field, we change this page first.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            We tell you before anything sends
          </h2>
          <p className="text-warm-gray leading-relaxed">
            The very first time DorkOS starts, it prints a plain notice in its log: what it shares,
            a link to this page, and how to turn it off. Nothing is sent on that first run. If you
            do nothing, the daily heartbeat and install counts begin on the next launch. If you turn
            them off first, they never start.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Marketplace installs</h2>
          <p className="text-warm-gray leading-relaxed">
            The install-count channel is on by default too, and it helps us rank packages and spot
            broken installs. It follows the same no-PII rule and is documented in detail on the{' '}
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
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Error reporting (a separate opt-in)
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS can also send a crash report when something breaks, so we can fix it without
            asking you to dig through log files. Unlike the heartbeat, this one is off until you
            turn it on, for two reasons:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              It goes to a <span className="text-charcoal font-semibold">third party</span>, not to
              us directly. You point it at your own{' '}
              <a
                href="https://sentry.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-charcoal hover:text-brand-orange underline"
              >
                Sentry
              </a>{' '}
              or self-hosted{' '}
              <a
                href="https://glitchtip.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-charcoal hover:text-brand-orange underline"
              >
                GlitchTip
              </a>{' '}
              project. Nothing is sent unless you set that up.
            </li>
            <li>
              We send the error type and a cleaned-up stack trace (which function, which file, which
              line), and nothing else. We do{' '}
              <span className="text-charcoal font-semibold">not</span> send the error message text
              at all, because a message can contain whatever your code put in it. No prompts, no
              code, no file contents, no session data.
            </li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            Before anything is sent, home directories and full file paths are stripped (so no
            username leaks), and anything that looks like a key, token, or password is redacted. To
            turn it on you set two things: a <span className="font-mono">SENTRY_DSN</span>{' '}
            environment variable pointing at your project, and{' '}
            <span className="font-mono">telemetry.errorReporting: true</span> in your config. Leave
            either one unset and nothing is reported.
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
              config, so it silences DorkOS everywhere at once.
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
    "heartbeat": true,        // the daily ping (on by default)
    "install": true,          // marketplace install counts (on by default)
    "errorReporting": false,  // crash reports (off; also needs SENTRY_DSN)
    "userHasDecided": true
  }
}`}</code>
          </pre>
          <p className="text-warm-gray leading-relaxed">
            Set a value to <span className="font-mono">false</span> to turn a channel off, or{' '}
            <span className="font-mono">true</span> to turn it on. The two anonymous channels
            default to <span className="font-mono">true</span>; error reporting defaults to{' '}
            <span className="font-mono">false</span>.
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
            the whole payload, and we make turning it off a one-liner. Your code and your chats with
            the AI never leave your machine, default or not.
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
