---
slug: effortless-runtime-switching
number: 271
created: 2026-07-03
status: implemented
---

# Effortless Runtime Switching — Implementation Record

**Tracker:** DOR-183 · **Status:** shipped (all three tiers merged to `main`).

Delivered the full T0+T1+T2 scope as three tier-scoped PRs, each independently gated (isolated agent batches → holistic gate → adversarial review → fix → automated review → merge).

## Shipped

| Tier                         | PR                                                 | Squash     | What landed                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0** — truth + consistency | [#78](https://github.com/dork-labs/dorkos/pull/78) | `0852deb1` | Codex SDK-vendored binary resolution (kills the false "needs setup"; ADR-0316); shared `configured → vendored → PATH` resolver; async + time-bounded + concurrent dependency probes (no event-loop block); two-state Ready/Connect projection + Advanced disclosure; opt-in on-demand OpenCode provisioning (ADR-0317); three-siblings presentation.                   |
| **T1** — kill the terminal   | [#79](https://github.com/dork-labs/dorkos/pull/79) | `5947e8a1` | `CredentialProvider` port + `providers` config (references-only, AES-256-GCM at rest, secrets via stdin; ADR-0315); `0.48.0` conf migration; connect-flow-per-provider (delegate `claude auth login`/`codex login`, native API-key; ADR-0318); OpenRouter paste-key + OAuth-PKCE; zero-auth Ollama detection; the OpenCode provider picker (Local / Gateway / Direct). |
| **T2** — discovery + delight | [#80](https://github.com/dork-labs/dorkos/pull/80) | `c4bfe5b8` | identity = runtime + model everywhere; "Run this with…" (re-run into a fresh session per ADR-0255, never a mutation/transplant); per-model nature badges (🔒 local·free vs $ cloud); the dedicated `/runtimes` discovery surface (composes the T1 flows); guided hardware-aware Ollama pull (honest sizing + fit verdict + streamed progress → zero-auth connect).     |

## Decisions

All four ADRs accepted: **0315** CredentialProvider port · **0316** SDK-vendored binary resolution · **0317** opt-in provisioning · **0318** connect-flow-per-provider. (Numbered 0315–0318 to sit above the concurrent `accounts-and-auth` spec's reserved 0311–0314.)

## Verification

Each tier: full workspace typecheck (23/23), full test suite (server ~245 + client ~392 files), build, lint 0 errors. Runtime conformance (claude-code · codex · opencode · test-mode) green throughout; the Codex `CodexOptions.env`-unset invariant preserved. Two adversarial-review-caught concurrency races (OpenCode boot shutdown-resurrection; provision double-install) fixed with regression tests in T0/T1; the T1 security review confirmed no secret-leak / auth-bypass.

## Follow-ups (non-blocking, documented)

- **OpenRouter OAuth-PKCE**: 3 wire-details (state-in-callback, loopback-callback-with-query acceptance, `HTTP-Referer`/`X-Title` requiredness) need live re-verification against OpenRouter; behind an injectable `fetchImpl` seam, with paste-key as the always-available fallback.
- **Vendor-CLI login flows** are unit-tested with mocked spawns; command names/flags are verified against the real bundled binaries, but a full interactive login round-trip (`claude auth login`, `codex login` ChatGPT) needs an env-gated manual smoke with the real binaries + accounts.
- **VRAM detection** is not performed (non-blocking ethos); the hardware heuristic degrades to RAM-only + an Apple-Silicon unified-memory signal. The heuristic already accepts an injected `vramBytes`.
- **`services/runtimes/opencode/`** crossed the 15-file soft threshold — a candidate for domain-grouping.
