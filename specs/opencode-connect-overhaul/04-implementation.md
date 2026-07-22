---
id: 260722-184734
slug: opencode-connect-overhaul
tracker: DOR-421
status: implemented
---

# OpenCode connect overhaul — implementation record

Shipped 2026-07-22 in two squash-merged PRs, both on `main`:

- **PR #416** (DOR-422, server): credential-aware readiness (the root-cause fix; ADR `260722-185415`), shared `ModelTier` vocabulary + tiered/sorted `projectModelOptions` with the `capLocalTier` honesty guard, Ollama installed-models-with-verdicts + 6-model curated catalog + pull-by-name, bounded `nvidia-smi` VRAM probe.
- **PR #419** (DOR-423, client): power-source picker (three cards, approved copy verbatim), success moment + runtime handoff, tiered searchable model menu with "this Mac · private" marks, local panel scope B, dead OpenRouter model-catalog path deleted end-to-end, and `OpenCodeServerManager.recycle()` fired on credential persist (spec Risks item — confirmed real: the sidecar only read credentials at spawn).

## Verification

- Both PRs: full CI green (integration, smoke matrices, Docker, tarball, openapi-fresh, fragment gate) + on-demand Claude review (PR1: 0 important/1 nit — fixed in PR2; PR2: 0 important/1 nit — fixed pre-merge).
- Pre-PR independent reviews per `REVIEW.md` on both branches (both APPROVE-WITH-NITS; all nits fixed before the PRs opened).
- 244/244 opencode adapter suite incl. runtime conformance; 197 targeted tests across PR2's touched files; full client suite green in-worktree.
- Not machine-verified: a live OpenRouter connect on a running cockpit (needs real credentials in a browser session). The handoff chain is covered link-by-link by tests; the first live dogfood pass should confirm acceptance criteria 1–2 end to end.

## Deviations from spec (all documented in PR bodies)

- `ModelOption.tier` already existed with a legacy vocabulary (`flagship|balanced|fast|specialized|legacy`); the enum was widened additively rather than replaced. Legacy values group under "More models."
- The post-hoc assessment for non-curated pulls rides the installed-list refetch, not the pull SSE result.
- Login-flow connects (Claude/Codex via the toolbar chip) also get the success panel — removing the silent auto-close required it.
- `sortModelOptions` treats untiered as last; the guided-pull default stays `qwen2.5-coder:7b` explicitly.

## Follow-ups (non-blocking)

- `services/runtimes/opencode` is at 18 source files (soft cap 15) — future tidy.
- Direct-provider readiness parity: a custom Direct provider id reads ready once its ref resolves, but `OPENCODE_PROVIDER_ENV_VARS` maps only openrouter/openai/anthropic — extend when the provider picker grows.
- Consider a runtime-agnostic post-credential hook registry if more runtimes gain provider credentials (today `connect/credentials.ts` names the opencode sidecar's recycle seam directly).

## v1.1 (PR3, DOR-427) — shipped 2026-07-22

Post-dogfood polish, merged as PR #423: Change affordance on a ready OpenCode (power-source switching with the current source labeled and the same success moment, riding the new optional `RuntimeRequirements.provider`); Ollama model menu offers only installed tags (catalog metadata wins, custom pulls listed plainly, installed always wins over `deprecated`, unreadable-vs-empty Ollama distinguished); vanished saved models render "(not available)" with a hint; unavailable-model turn failures map to plain copy pointing at the model menu (pattern-matched on verified upstream shapes only — the SDK has no typed model-not-found error). Two review rounds (pre-PR + CI), all seven nits fixed pre-merge.
