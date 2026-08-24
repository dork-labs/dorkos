---
id: 260824-232523
title: Comparison pages derive every DorkOS claim from the feature catalog
status: accepted
created: 2026-08-24
spec: comparison-pages
superseded-by: null
amends: null
---

# 260824-232523. Comparison pages derive every DorkOS claim from the feature catalog

## Status

Accepted. Verified in code: `apps/site/src/layers/features/marketing/lib/comparisons.ts` — `dorkosCellFor()` computes every DorkOS verdict from `features.ts` statuses; `UNPROVEN_STATUSES = new Set(['alpha', 'coming-soon'])` forces `partial` over any unproven backing feature; no hand-authored DorkOS cell exists anywhere in the file.

## Context

The `/compare` pages (20 competitor pages + hub, spec `comparison-pages`) exist to win comparison searches. The commercial pressure on such pages is to overstate the home product, and the repo's honesty rule ("never state that an unverified surface works") is prose, which agents and editors drift from. We needed the site to be biased toward DorkOS where the facts allow it, and structurally unable to overstate where they don't.

## Decision

Three rules, all enforced by code and invariant tests rather than editorial discipline:

1. **DorkOS's side of every comparison row is derived, never written.** `dorkosCellFor(dimension)` maps the row's backing feature slugs to a verdict from their catalog `status`; any `alpha`/`coming-soon` feature in the set caps the verdict at `partial` with a note naming what is early. Making a comparison claim better requires shipping (and re-statusing) the feature, not editing the page.
2. **Rival cells state facts with sources.** Every `yes`/`partial` rival cell carries a URL that was actually loaded; absence claims use the hedged register ("We found no…"). Tests enforce the source requirement.
3. **Three page framings, one canonical URL per pair.** `competitor`/`adjacent` compare, `runtime` complements ("DorkOS + X"), `discontinued` serves migration intent; URLs are DorkOS-first (`/compare/<slug>`), the reverse order is never published.

## Consequences

- Bias is achieved by axis selection (dimensions chosen where DorkOS genuinely wins), never by shading cells — a reviewer can recompute the DorkOS column from the catalog.
- The catalog's `status` fields became load-bearing for marketing truth. As of 2026-08-24 the catalog holds zero `alpha` features, so the gate has nothing left to catch: the residual risk is a feature raised to `ga` ahead of its evidence, which no test can see. Status raises deserve review scrutiny equal to code.
- Rooms, connections, and the Slack adapter had stale statuses that understated shipped reality for weeks; the derived design surfaced that as visibly wrong pages, which is the system working.
- The `lastVerified` freshness test (≤120 days) turns market churn (three roster products died or were acquired inside two months) into a failing test instead of a stale page.
