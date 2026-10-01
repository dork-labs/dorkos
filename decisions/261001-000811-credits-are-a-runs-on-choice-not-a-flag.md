---
id: 261001-000811
title: DorkOS credits are a choice in Runs on, never a flag and never a silent switch
status: accepted
created: 2026-10-01
spec: dorkos-account-by-default
superseded-by: null
amends: null
---

# 261001-000811. DorkOS credits are a choice in Runs on, never a flag and never a silent switch

## Status

Accepted (DOR-2623, spec `dorkos-account-by-default` §1, decisions D2, D3 and D7).

It replaces the rule that put DorkOS credits on the repo's money-path table as "a flag beside its own key" (`DORKOS_CLOUD_CREDITS=1` beside the cloud-link credential, DOR-2027). The other six money paths keep that rule unchanged.

## Context

Credits were switched on only by `DORKOS_CLOUD_CREDITS=1`. There was no setting in the app, so a desktop user would have had to relaunch from a terminal. Once on, the credits token was spread last into every Claude Code launch, so it beat the person's own sign-in for every agent: a silent double bill. The token lived only in memory and nothing minted it at startup, so a restart quietly dropped credits; an expired token quietly fell back to whatever sign-in was there. Each of those is somebody paying for something they did not choose.

## Decision

**Who pays for a turn is always a choice a person made, or a default they were told about.** Credits are one more entry, `dorkos-credits`, in a runtime's existing Runs on list. For Claude Code that is the account ladder: a session's own pick, the agent's account, then the machine default; a project rule can block credits but never chooses them. An agent's own file (`.dork/agent.json`) naming credits counts only for an agent a person allowed in the app: that consent lives in DorkOS config (`cloud.credits.agents`), never in the file, so a cloned or agent-written file cannot start spending. There is no new per-runtime field. A credits session runs in a folder DorkOS owns (`<dorkHome>/runtimes/claude-code/credits`), never a registry row, so a resumed conversation stays on whatever paid for it (ADR 260801-204127), and flow's CLI, which reads the same registry, never sees a folder it could launch without the token. The machine default is recorded in `cloud.credits.defaults`, beside the person's own `defaultAccount`, which is left untouched; turning credits off returns to it.

**The choice resolves per session at launch, and fails closed.** A launch whose account is the credits folder gets the endpoint and token or is refused with a plain sentence ("Couldn't reach DorkOS credits · Retry · Use your Claude Code sign-in"). It never runs on anything else. A launch on the person's own sign-in gets no credits variable at all. Automatic steps never move work onto credits: the ladder's fallback skips them, and an advisor's automatic handoff accepts only registered accounts. A person can still pick credits in "Continue on another account". A token with less than the refresh margin left is never handed to a launch, and a token refused partway through a turn ends it with the credits card, never a Claude sign-in error or notification.

**Nothing but the credits endpoint can receive the token, and nothing but the token can pay.** Inside the CLI a folder's own `.claude/settings.json` and `settings.local.json` `env` outrank the process environment, so a folder could point `ANTHROPIC_BASE_URL` at its own server and receive the token (reproduced against the bundled binary). So a credits turn is built in two layers. The process environment keeps the baseline names, DorkOS's own, the person's inherit list and the credits pair, minus every name that routes a turn or pays for one: `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*`, OAuth tokens and the cloud credential families (`AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`, `AZURE_*` and the like), whichever list carried them. The launch's own settings (`options.settings.env`), which outrank project settings, carry the endpoint, a blank over every routing and credential variable Claude Code knows, and a blank over every such name a folder's settings set. A folder that sets `PATH`, a proxy or a certificate variable gets the server's own value put back, never a blank, because a proxy or certificate the folder names could read the token in flight. Every other variable a folder sets (a `DATABASE_URL`, a tool's home) is left to the folder, so its hooks and commands work on credits as on any other sign-in. The warm-process fingerprint pins all of this. The token stays out of those settings, because the SDK passes them on the command line. A folder whose settings name their own sign-in (`ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper`) would swap the person's own credential in, so that launch is refused; the refusal offers "Don't use credits in this project", which saves a project rule without credits. Managed (policy) settings outrank all of this and are the organisation's.

**What this does not protect against, said plainly.** The token is in the process environment of the turn, so anything that turn runs can read it: a repository's hooks, its MCP servers, and any command the agent runs. A hostile repository opened on credits can therefore take the token and spend from it until it expires or is revoked, exactly as it could take a person's own API key from their environment. The layers above stop a folder's settings from redirecting or replacing the token; they do not make it safe to run code you do not trust on credits, any more than on your own key.

`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not set. The bundled binary supports it, but it also forces every session to the default permission mode unless `allowedTools` is declared, which DorkOS deliberately never does (ADR `260726-171347`), so it would silently override the mode a person chose.

**Every choice records what it is and who made it.** Each runtime's record is `credits` or `own-sign-in`, chosen by `user` or by `default`. A person's "no" (turning credits off, or Undo all) is a recorded `own-sign-in` that nothing overrides. A new link fills only true gaps: a runtime with no record and no sign-in at all. An expired or out-of-usage sign-in is not a gap; it needs signing in again. The person is told once, with Change and Undo all, and if that runtime's own sign-in later works, switching back is offered once. A computer linked before this shipped is never armed by migration; it gets one dismissible offer instead. A new link to a different DorkOS account (or one that cannot be told apart) starts every choice over; a relink to the same account keeps them.

**Unlinking stops credits at once.** Before the link is cleared, the held token is revoked under it and every credits session's turn and warm process is stopped. The choices themselves are kept: a session set to credits is then refused, never moved. The revoke call waits a few seconds at most; when it fails (the computer is offline, or the cloud does not answer), the link is cleared anyway and the token is dropped here, but it stays valid at the cloud until it expires on its own, at most one token lifetime. Nothing on this computer uses it after the unlink; a copy taken earlier could, for that window.

**The token is kept live, not stored.** The link credential is already kept, so the server mints a token at startup, again before each one expires, and on a new link. A launch that finds none waits for one bounded mint and refuses if it fails.

**`DORKOS_CLOUD_CREDITS` is a kill switch only.** `0`, `false`, `no` or `off` turns credits off for the server: every credits launch refuses, and nothing falls back. Any other value, including the old `1`, changes nothing. It is still read once at module scope and still kept out of every turbo task.

**Credits are a declared runtime capability.** `RuntimeCapabilities.credits` names the protocol a runtime speaks to the endpoint, and absence means no. The host hands a token only to a runtime that declares it, and the wired set every status line reports is derived from those declarations. Only Claude Code declares it today (`anthropic-messages`); Codex and OpenCode join with their own protocols later. `runtimeConformance` holds every runtime to three negatives: no token to a runtime that did not declare credits, a credits turn with no live token refuses and starts nothing, and a turn on the runtime's own sign-in carries no credits token.

## Consequences

### Positive

- No credits turn can ever bill a person's own sign-in or key, and no own-sign-in turn can ever carry a credits token; both are pinned by tests that fail if either rule is broken.
- Credits work after a restart, and an expired token is replaced before a turn finds it.
- A desktop user can choose credits in the app, and is told when DorkOS chose for them.
- Adding credits to another runtime is a declaration plus its protocol's variables, with the conformance negatives already waiting for it.

### Negative

- A session set to credits is refused while this computer is unlinked or credits are switched off. That is the point, but it means one more refusal a person can meet; the card offers their own sign-in in one click.
- A project's own `.claude/settings.json` can still set environment variables the CLI reads after launch. DorkOS blanks or overrides the ones that route, pay or proxy, but does not rewrite a person's project settings, and leaves every other variable to the folder.
- Code a credits turn runs can read the credits token, the same as a person's own key (see above). Credits are no safer than a key for a repository you do not trust.
- A failed revoke on unlink leaves the token valid at the cloud until it expires on its own.
- The machine default for credits lives in `cloud.credits`, apart from `runtimes.claudeCode.defaultAccount`, so "what is the default" has two fields to read. The client reads them through one view (`useClaudeAccounts`), and the server through one ladder.
