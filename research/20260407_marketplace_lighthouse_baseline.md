---
type: research
date: 2026-04-07
spec: marketplace-04-web-and-registry
status: deferred
---

# Marketplace Lighthouse & Accessibility Baseline — Deferred

## Status

**DEFERRED pending registry deployment (task #28).**

## Why deferred

The marketplace browse page (`/marketplace`) and detail pages (`/marketplace/[slug]`) fetch from `https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json` at ISR time. That registry URL does not exist yet — it's created by task #28 (manual GitHub org bootstrap).

Running Lighthouse today would measure:

- `/marketplace`: the empty-state page (graceful degradation on registry 404)
- `/marketplace/[slug]` for any slug: a 404 from Next.js (no packages resolved by `generateStaticParams`, no ISR cache)

Neither audit would be representative of the production experience.

## What to audit (after #28 completes)

1. `http://localhost:3000/marketplace` — full package grid with 8 seed packages, featured rail, filter tabs
2. `http://localhost:3000/marketplace/code-reviewer` — most-populated detail page (README, install count, related packages)
3. `http://localhost:3000/marketplace/privacy` — static page (safe to audit now if desired)

## Acceptance criteria from spec

- [ ] LCP < 2500ms for both `/marketplace` and `/marketplace/code-reviewer`
- [ ] Accessibility category score === 1.0 for both pages

## How to run when ready

```bash
# Terminal 1
pnpm dev --filter @dorkos/site

# Terminal 2 — run Lighthouse via chrome-devtools-mcp
# (Agent invocation using the chrome-devtools-mcp:debug-optimize-lcp skill)
```

## Followup

File a Linear issue `marketplace: lighthouse baseline` once task #28 deploys, then run the audit and update this file with measured metrics.

## Privacy page audit (can run today)

The `/marketplace/privacy` page is fully static and has no registry dependency. It SHOULD be auditable today. If the reviewer wants, run a quick Lighthouse pass against that one page to verify the static-page baseline is clean.
