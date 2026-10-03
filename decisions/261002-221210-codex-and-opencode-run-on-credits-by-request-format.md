---
id: 261002-221210
title: Codex and OpenCode run on credits through their own request format, offered only once it is served
status: accepted
created: 2026-10-02
spec: dorkos-account-by-default
superseded-by: null
amends: 261001-000811
---

# 261002-221210. Codex and OpenCode run on credits through their own request format, offered only once it is served

## Status

Accepted (DOR-2633, spec `dorkos-account-by-default` decision D7). It amends ADR `261001-000811`, which declared credits for Claude Code alone and left the other two runtimes "to join with their own protocols later". Everything that ADR settles (who chooses, fail closed, the kill switch, the token lifecycle, the three conformance negatives) holds unchanged for both.

## Context

Codex and OpenCode each speak a different vendor format, and neither has an account list the way Claude Code does. Codex 0.154 speaks only the responses format: its CLI refuses `wire_api = "chat"` outright. OpenCode speaks chat completions through a provider package it bundles. The credits service serves chat completions today and not yet responses. OpenCode also runs every session through one shared sidecar process, in which a project's plugin can read the environment.

## Decision

**The token says which formats are served.** `InferenceEndpointsSchema` (in `@dork-labs/cloud-api`) gains an optional `openaiResponses` endpoint beside the two it always carried. An absent endpoint means that format is not served for this token, and nothing may be sent in it. A runtime's `credits` capability names its format (`anthropic-messages`, `openai-chat-completions`, `openai-responses`) and its scope. A runtime counts as wired only when it declares credits AND the format it declares is served (`creditsRuntimeWired`): the two required formats always are, the optional one only while the live token carries it. Every offer reads that answer: the status report, "Use credits for", a runtime card's Runs on choice, filling the gaps on a new link, and the route that records a choice. So Codex declares credits now and is offered nothing until the service sends the responses endpoint. A launch on an unserved format is refused as `not-supported`, never sent to another endpoint.

**Codex: a home of its own, a provider entry per turn.** A Codex turn on credits runs with `CODEX_HOME` set to `<dorkHome>/runtimes/codex/credits`, never the person's `~/.codex`. The CLI is handed a `dorkos-credits` model provider as `--config` overrides (endpoint, `wire_api = "responses"`, `env_key` naming the token's variable, `requires_openai_auth = false`). The token rides only the environment. Nothing of the person's `OPENAI_*` or `CODEX_*` reaches the turn. Their `config.toml`, sign-in and `OPENAI_BASE_URL` are never read or written. The credits home holds no sign-in, so a turn that lost its token sends nothing at all. Which side a thread is on is read off the disk: its rollout lives in exactly one home, so a conversation stays on whatever paid for it (the rule of ADR `260801-204127`). A new thread follows Codex's recorded default. Codex has no account hint per send, so its Runs on choice is that default.

**OpenCode: credits are a mode of its one sidecar.** A token in a sidecar that also serves the person's own providers would be readable by every project opened there. So OpenCode's recorded choice decides what the whole sidecar boots on. On credits, it boots with the credits provider and no other one: `enabled_providers` is pinned to `dorkos-credits`, its endpoint is set, and the token is named by `{env:…}`, all merged last through `OPENCODE_CONFIG_CONTENT`, which outranks every config file. The person's provider keys and `OPENAI_BASE_URL` are left out. On their own sign-in, it boots exactly as before, with no credits variable. A change of the choice recycles the sidecar, the way a new power source already does. That moves every conversation, and the copy says so (`scope: 'runtime'`). On credits with no live token, the sidecar boots able to pay for nothing and every turn is refused; it never falls back to the person's providers. A new token is picked up when the sidecar is idle. A sidecar still running turns on the old token keeps them, because that token bills the same link and is still good. Unlink and a new link recycle it at once. The models it offers are the ones the service lists for the link (`GET /v1/inference/models`). A turn keeps the session's model when it is one of those, else it takes the first that can call tools.

**What this does not protect against**, the same as ADR `261001-000811` says for Claude Code. Code a credits turn runs (an MCP server, a command, an OpenCode plugin in a project on credits) can read the token from its own environment.

## Consequences

### Positive

- Adding the responses endpoint on the service side turns Codex on with no app release. Until then nothing claims it works.
- Neither runtime's own configuration is touched, and neither can bill the person's own sign-in on a credits turn. Both are proved against the real binaries with fake local servers (`credits-provider.binary.test.ts`, `credits-mode.binary.test.ts`): a project's config cannot redirect the token, and a project's own provider is never reached on credits.
- Both pass `runtimeConformance` with the credits negatives wired, not waived.

### Negative

- OpenCode on credits is all or nothing for the runtime, and switching ends what it is running at that moment.
- A Codex conversation started on credits cannot move to the person's own sign-in. "Use your Codex sign-in" on its refusal changes the default for new conversations, and the retry of that thread is refused again.
- OpenCode reads the model list when the sidecar boots on credits. A model the service adds later appears after its next recycle.
- The OpenCode binary proof runs only where `opencode` is installed (not in CI). The Codex one runs wherever the SDK's vendored binary is installed.
