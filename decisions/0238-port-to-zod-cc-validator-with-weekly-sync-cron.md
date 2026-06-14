---
number: 238
title: Port-to-Zod CC Validator with Weekly Sync Cron
status: accepted
created: 2026-04-07
spec: marketplace-05-claude-code-format-superset
superseded-by: null
---

# 238. Port-to-Zod CC Validator with Weekly Sync Cron

## Status

Accepted (marketplace-05 implementation landed) — **amended 2026-06-13: weekly sync cron removed** (see Amendment).

## Amendment (2026-06-13)

The **weekly sync cron** half of this decision (`.github/workflows/cc-schema-sync.yml` + `scripts/sync-cc-schema.ts`) has been **removed**. The Zod port (`cc-validator.ts`) and the sync-direction invariant below remain fully in force — only the automated drift monitor is gone.

It was removed because it never functioned across its entire lifetime (0 of 9 scheduled runs succeeded):

1. The workflow invoked `pnpm tsx` but `tsx` was not a root dependency until 2026-06-09 — every scheduled run before then failed at "command not found."
2. Even with `tsx` present, the PR-creation path runs `gh pr create` without ever creating a branch or committing the report, so it has no diff to open a PR from — it would fail at the final step.
3. The diff logic (`extractUpstreamFields`) reads `properties.plugins.items.properties` but the upstream schema defines plugin fields via `$ref → #/$defs/pluginEntry`, which it does not resolve — so every run reports the full plugin field set as spurious drift.

Beyond being broken, the monitor's value was marginal: the reference schema is an admittedly-lagging, single-maintainer community artifact (see Context), so the signal would have been low-confidence and noisy even if the mechanics worked.

**Going forward**, drift is reconciled manually: when CC's marketplace format changes, update `cc-validator.ts` against the community reference, preserving the sync-direction invariant. If an automated monitor is wanted later, it should emit a notification (e.g. `gh issue create`), resolve `$ref`, and run against a more authoritative oracle.

## Context

The DorkOS marketplace format is a strict superset of Claude Code's format, which means we need an oracle to verify that DorkOS-generated `marketplace.json` files pass CC's validator. Claude Code is distributed as a closed-source binary, however, and the canonical schema URL referenced in CC's docs (`https://anthropic.com/claude-code/marketplace.schema.json`) does not serve a public schema. Anthropic has not published a stability guarantee or versioning policy for the marketplace format. The validator has drifted at least 4 times in 6 months (Issues #15198, #20423, #26555, #33739).

Three validation strategies were considered:

1. **Shell out to `claude plugin validate`** — requires a 200+ MB CC binary in CI, Anthropic auth, version pinning, and CC auto-updates. CI reliability would be ~70%.
2. **Vendor CC's validator** — impossible because the binary is proprietary and obfuscated.
3. **Port the schema to Zod** — use the community-maintained `hesreallyhim/claude-code-json-schema` as reference, translate its shape into Zod, and maintain a sync process.

The community reference has known caveats: it's intentionally lagging the actual CLI validator in some places, has only 4 stars (one-maintainer artifact), and its README explicitly documents discrepancies. Despite those limitations, it is the only public artifact that approximates CC's validator behavior.

## Decision

Port the CC marketplace schema to Zod in `packages/marketplace/src/cc-validator.ts`, using `hesreallyhim/claude-code-json-schema` as reference. The port uses `.strict()` on plugin entries to mirror CC's `additionalProperties: false` behavior and reject inline DorkOS fields. Set up a weekly CI cron (`.github/workflows/cc-schema-sync.yml`) that fetches the latest reference schema, diffs against DorkOS's port, and opens a pull request on drift.

Establish a **sync direction invariant**: DorkOS's Zod schema MUST NOT be stricter than CC's actual CLI behavior for any field CC currently accepts. Looser-than-CC is acceptable (we may accept valid CC marketplaces that the unofficial reference rejects); stricter-than-CC is a regression that must be fixed immediately. This invariant exists because false positives (DorkOS rejecting valid CC packages) break bidirectional compatibility; false negatives (DorkOS accepting packages CC rejects) are only visible if the user also runs CC, so they cost less.

## Consequences

### Positive

- Native Zod validation — no binary dep, no network dep, no auth required
- Runs in the normal `pnpm test` flow — zero CI infrastructure changes
- Weekly sync cron catches schema drift before it causes production issues
- Community-maintained reference schema is freely updated by a third party
- DorkOS owns the schema artifact in its own repo, under its own control

### Negative

- Must track CC schema changes manually — there is no compile-time guarantee of parity
- Schema drift risk requires ongoing maintenance (weekly cron + PR review)
- Cannot detect differences between the unofficial schema and the real CC CLI behavior without manually running `claude plugin validate`
- Adds a maintenance commitment that outlasts the initial spec
