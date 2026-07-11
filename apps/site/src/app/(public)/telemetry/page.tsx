import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Telemetry',
  description:
    'Exactly what the optional DorkOS heartbeat sends, how to turn it on or off, and our private-by-default promise.',
};

const HEARTBEAT_PAYLOAD = `{
  "instanceId": "a1b2c3d4-e5f6-...",
  "dorkosVersion": "0.46.0",
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
          <p className="text-warm-gray text-lg">Last updated: July 11, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. It is private by default. Nothing about how you
            use it leaves your computer unless you turn it on, and this page shows you the exact
            data it would send, word for word, before you decide.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>Telemetry is off until you opt in. Fresh installs send nothing.</li>
            <li>We ask once, on first run, and show you the payload below before you choose.</li>
            <li>It is anonymous. No prompts, no code, no file paths, no session content, ever.</li>
            <li>You can change your mind anytime in settings or your config file.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            What the heartbeat sends
          </h2>
          <p className="text-warm-gray leading-relaxed">
            If you opt in, DorkOS sends one small message to dorkos.ai about once a week. This is
            how we can even roughly count how many people are actively running DorkOS. Here is the
            whole thing:
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
            hostname or username, IP address, or anything from your sessions. If we ever want to add
            a field, we change this page first.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Marketplace installs</h2>
          <p className="text-warm-gray leading-relaxed">
            The same opt-in also turns on anonymous marketplace install events, which help us rank
            packages and spot broken installs. Those follow the same no-PII rule and are documented
            in detail on the{' '}
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
            asking you to dig through log files. This is different from the heartbeat in two
            important ways, so it is its own separate choice and is never turned on by the
            &quot;share anonymous data&quot; banner:
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
            How to turn it on or off
          </h2>
          <p className="text-warm-gray leading-relaxed">
            The first time you open DorkOS, a banner asks whether to share anonymous data and shows
            you the payload above. Pick either option and it remembers your choice. To change it
            later, open settings, or edit your config file at{' '}
            <span className="font-mono">~/.dork/config.json</span>:
          </p>
          <pre className="border-warm-gray-light/30 text-charcoal overflow-x-auto rounded-xl border bg-black/[0.03] p-4 text-sm">
            <code>{`{
  "telemetry": {
    "heartbeat": false,       // the weekly ping
    "install": false,         // marketplace install events
    "errorReporting": false,  // crash reports (also needs SENTRY_DSN)
    "userHasDecided": true
  }
}`}</code>
          </pre>
          <p className="text-warm-gray leading-relaxed">
            Set a value to <span className="font-mono">true</span> to opt in, or{' '}
            <span className="font-mono">false</span> to opt out. The default for every channel is{' '}
            <span className="font-mono">false</span>.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            We would rather undercount
          </h2>
          <p className="text-warm-gray leading-relaxed">
            Because this is off by default, our numbers only reflect the people who chose to share.
            That means we undercount, on purpose. We think a private-by-default product that flies a
            little blind is the right trade.
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
