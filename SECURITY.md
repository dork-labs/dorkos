# Security

Thanks for helping keep DorkOS and its users safe. DorkOS is an early open-source alpha built by a very small team, and we take security reports seriously.

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub issue for a vulnerability, and do not share it on social media until it is fixed.

Two private channels, either is fine:

- **Email** [security@dorkos.ai](mailto:security@dorkos.ai).
- **GitHub** use "Report a vulnerability" under the repository's Security tab (private advisory).

A good report usually includes:

- What the problem is and why it matters.
- Steps to reproduce it, or a small proof of concept.
- The DorkOS version (`dorkos --version`) and your operating system.
- Anything you already know about the impact or a possible fix.

## What to expect

We are a one-person team plus a fleet of agents, so we are honest about pace rather than promising a formal SLA:

- We aim to **acknowledge your report within three business days**.
- We will tell you whether we can reproduce it and what we plan to do.
- We fix confirmed issues before we move on to new features, and we will keep you posted while we work.
- When a fix ships, we credit you by name if you would like, or keep you anonymous if you prefer.

If you do not hear back within a week, please send a gentle nudge in case a message got lost.

## Which versions get fixes

DorkOS is pre-1.0 and moves fast. Only the **latest published release** receives security fixes. If you are running an older version, the fix is to update:

```bash
npm install -g dorkos@latest
```

## The trust model, in plain words

Some things that might look like bugs are how DorkOS is designed to work. Knowing the model helps you tell a real vulnerability from expected behavior:

- **DorkOS runs on your machine and trusts your machine.** By default there is no login and it listens on localhost only. Anything already running as your user can talk to it. That is the same trust level you give any other developer tool you run.
- **Exposing DorkOS beyond localhost requires login.** Starting a tunnel or binding to a public network interface will not work until you turn on an owner account. This is enforced, not advisory.
- **Running an agent means trusting it with your computer.** Agents can read and write files and run commands within the boundary you set. Installing a marketplace package runs its code. Only install packages you trust.
- **You bring your own AI keys.** Your prompts and code go straight to the model vendor you chose, under their terms. DorkOS keeps no copy.

For the full picture, see the [threat model](https://dorkos.ai/docs/self-hosting/threat-model) and [Securing your instance](https://dorkos.ai/docs/self-hosting/securing-your-instance).

## Good-faith research

We will not pursue or support legal action against anyone who reports a vulnerability in good faith, follows this policy, and avoids privacy violations, data destruction, and service disruption while researching. Thank you for doing it the right way.
