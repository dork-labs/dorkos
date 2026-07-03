---
number: 318
title: Connect-flow-per-provider (delegate subscription OAuth, native where invited)
status: draft
created: 2026-07-03
spec: effortless-runtime-switching
superseded-by: null
---

# 0318. Connect-flow-per-provider (delegate subscription OAuth, native where invited)

## Status

Draft (auto-extracted from spec: effortless-runtime-switching)

## Context

Making connect terminal-free must not mean reimplementing a provider's _subscription_ OAuth: Anthropic's Jan-2026 crackdown banned tools routing through Claude Max/Pro subscription tokens, and the equivalent for OpenAI's ChatGPT subscription is undocumented. Providers differ in what they invite: API keys are sanctioned everywhere, and OpenRouter is explicitly built for app OAuth. "In-app" is not the same as "we own the OAuth."

## Decision

Choose the connect flow per provider by what its terms invite, all terminal-free:

- **Claude:** delegate to `claude login` (button-triggered spawn, detect completion), or read host credentials, or paste an API key. Never a reimplemented claude.ai OAuth.
- **Codex:** native **API-key** entry (clean); "Sign in with ChatGPT" **delegates to `codex login`**. No native subscription OAuth until OpenAI's terms are verified.
- **OpenCode:** a provider picker; native OAuth only where the provider invites it (**OpenRouter OAuth-PKCE**), otherwise paste-key or a detected local Ollama (zero auth).

No provider subscription OAuth is reimplemented until that provider's terms are explicitly verified; delegation to the vendor CLI is the safe, still-terminal-free default.

## Consequences

### Positive

- Terminal-free connect that stays ToS-safe; native flows only where they are unambiguously invited.
- The two new (less-constrained) runtimes get the most polished connect; Claude stays on the conservative delegate path.

### Negative

- The connect UX differs across providers (delegate vs native vs picker); mitigated by presenting all of them behind the one Ready/Connect abstraction.
- Delegated logins require spawning a vendor CLI and detecting completion, a coordination surface to test.
