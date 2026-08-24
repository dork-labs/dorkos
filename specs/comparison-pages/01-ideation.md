# Ideation: /compare comparison pages

**Date:** 2026-08-23 · **Driver:** operator request (SEO + research) · **Research:** `research/20260823_comparison-pages-competitor-verification.md`, `research/20260823_comparison-pages-landscape-and-seo.md`, plus the site-substrate audit summarized in `02-specification.md` §2.

## The idea

A series of pages on dorkos.ai comparing DorkOS to other harnesses and agent platforms — for SEO (comparison keywords convert 5–10x informational content) and for our own competitive research hygiene. Already mandated in prose by `meta/positioning-202607/07-website-changes.md` §4.1 ("the cheapest high-intent SEO available to a bootstrapped product") and `05-marketing-strategy.md` §2.

## Key decisions made during ideation

1. **Tie into the existing feature system.** `apps/site/src/layers/features/marketing/lib/features.ts` is the authoritative, test-guarded catalog. A sibling `comparisons.ts` references feature slugs rather than restating copy. This is also the programmatic-SEO survival strategy (first-party data differentiation, post-March-2026 core update).
2. **Three framings, one route family.** `competitor` ("DorkOS vs X"), `runtime` ("DorkOS + X: mission control for X" — Claude Code/Codex/OpenCode are engines we manage, not rivals), `discontinued` ("X alternatives" — Terragon, Roo Code died in 2026; live migration traffic, no competition). Plus `adjacent` (a competitor-framing variant scoped to the overlap: OpenClaw, Hermes, Buzz).
3. **Honesty is structural.** `theirStrengths` is a required field; the honest-comparison format also converts best (~13.8% vs 2–5%).
4. **The demo-claim gate is enforced by tests.** A comparison cell backed by an alpha/coming-soon DorkOS feature can never render as an unqualified "yes".
5. **Canonical: one URL per pair, DorkOS-first** (`/compare/cursor`); never publish the reverse order.
6. **Last-verified dates are load-bearing** — visible on page, in the sitemap, and enforced by a freshness test. Three roster products died/rebranded within 7 months.

## Correction discovered during research

Our positioning claims Claude scheduling requires the machine to stay awake. Since July 2026, cloud-hosted Cowork sessions run scheduled tasks with the device off. `research/20260227_competitive_landscape_agent_infrastructure.md` and any Pulse copy leaning on that claim must be corrected (tracked as its own work item).
