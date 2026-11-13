---
slug: agent-browser-own-chrome
id: 261113-215637
created: 2026-11-13
status: ideation
---

# "Use my own Chrome": problem statement

**Status:** Problem statement only. No design until Security's own review of the questions below.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-3214 (Could since Nov 13), with its pieces DOR-3216 and DOR-3217
**Why:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md), §4, §4b and §9 action 6

## The problem

Some sites block or challenge the Agent browser even though it is honest: real Chrome, a visible window, no stealth. Two causes we can't fix in the Agent browser itself:

1. **Network address.** A cloud agent computer sits on a data-center address, which sites flag before they look at the browser. (Home-network routing, DOR-4290, is the other answer to this.)
2. **A fresh profile.** The Agent browser's saved sign-ins start empty. A person's everyday Chrome has years of history, trusted devices and passkeys, and sites trust it more.

A person could let one agent work in a tab of their **own** Chrome, on their own computer. The agent would then look like the person, because it would be acting in the person's real browser.

## Why it is the riskiest option

- The agent would act inside the person's real browser, next to their bank, mail and work tabs, and their real cookies.
- Every safety rule we have today lives in DorkOS's own browser layer. In someone else's browser we control less: other extensions, other tabs, the person's own clicks.
- It cuts against a past choice: the CLI avoids debugging ports on purpose (`packages/cli/src/lib/agent-browser/cdp-pipe.ts`), and an earlier attempt to connect to an existing browser was canceled (DOR-2972).

## Shapes it could take

From the research, two honest shapes exist. Neither is chosen.

- **An extension** in the person's Chrome that drives only the tabs the person shares with an agent, over `chrome.debugger` (patterns: Playwright's `cdpRelay`, OpenClaw's `extension-relay`, nanobrowser). Chrome shows its own "is debugging this browser" bar while it runs.
- **Chrome's own connection prompt** (DOR-3217), where Chrome asks the person to allow DorkOS.

## Questions for Security's review

1. Is acting in the person's own Chrome acceptable at all, and only on the person's own computer?
2. Must the agent be limited to tabs the person explicitly shared, with every other tab, window and profile invisible to it?
3. Which of today's rules must hold there, and how can each be enforced outside our own browser: chat ownership, the person-held page, the audit line per page, site rules, outsider holds, and refusing DorkOS and Cloud pages?
4. Must an outsider-marked turn be refused outright in the person's own Chrome?
5. How is the pairing secret between the extension and DorkOS created, stored and revoked? Where may it never appear (transcripts, agent-readable files)?
6. Is Chrome's own "debugging this browser" bar enough as the visible indicator, or must DorkOS show its own too?
7. Do we ship the extension through the Chrome Web Store, and who reviews each update?
8. Which browsers are in scope (Chrome, Edge, Brave, Arc), and does each one keep the same guarantees?

## Not now

No build, no spike and no date for a build. The next step is Security's answers.

## Date

Problem statement ready now. **Security's review of these questions: Wed Dec 9, 2026.** After that, the PM decides whether a design is worth writing.
