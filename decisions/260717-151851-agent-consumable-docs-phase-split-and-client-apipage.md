---
id: 260717-151851
title: Split agent-consumable docs from the fumadocs 16.10 / openapi 11 upgrade; migrate APIPage to a v11 client component
status: proposed
created: 2026-07-17
spec: agent-consumable-docs
superseded-by: null
---

# 260717-151851. Split agent-consumable docs from the fumadocs 16.10 / openapi 11 upgrade; migrate APIPage to a v11 client component

## Status

Proposed

## Context

DOR-165 bundled two things: user-facing **agent-consumable docs** (raw-markdown
routes, `llms-full.txt`, AI page actions) and a **fumadocs upgrade** (core/ui
16.7 → 16.10, openapi 10 → 11). The two bumps are welded — `fumadocs-openapi@11`
peer-requires `fumadocs-core/ui ^16.10` and openapi 10 peer-caps core below
16.10 — and an earlier deps PR tried the core bump, hit the openapi-11 wall, and
reverted **both**, taking the unrelated docs value down with it.

Verified against `node_modules` (not the ticket): the three AI-consumption
features already work at the installed versions — they need no bump. So the
upgrade risk and the docs value are technically independent. The upgrade's crux
was reconstructed (the revert commit is not in local git), not observed, so its
exact failure mode was a hypothesis (D6: openapi 11 makes `APIPage` a client
component that can no longer read the file-path `document` prop the 65 generated
MDX pages pass).

## Decision

**Ship the value and the upgrade as one spec, two sequenced phases, in two PRs.**

- **Phase A — AI consumption, no bump.** Raw `/docs/<slug>.mdx` route,
  build-time `/llms-full.txt`, and page actions, all on the installed fumadocs.
  Near-zero risk; ships first so the risky migration can never again hold the
  user value hostage.
- **Phase B — the welded bump, gated.** core/ui `^16.10` + openapi `^11`
  together, with an objective done-ness gate: `pnpm --filter @dorkos/site build`
  green **including `/docs/api/*` prerender**, the interactive reference renders,
  and the `openapi-fresh` CI gate stays green.

**Reproduce before fixing (O1).** Phase B's first step bumps the deps and runs
the build to capture the _real_ failure, rather than trusting the reconstructed
hypothesis. Phase B is defined by its gate, not by the hypothesis — if the
observed cause differs, the fix adapts within the gate.

**Migrate `APIPage` to a client component.** Under openapi 11 the factory is
`createOpenAPIPage()` (renamed from `createAPIPage`, no server arg) and returns a
`'use client'` component that renders from serialized props. `lib/openapi.ts`
keeps only the server `openapi` instance; `components/api-page.tsx` becomes the
client module; the catch-all server page bundles each API page's schema at build
time via `openapi.preloadOpenAPIPage(page)` and binds it into `APIPage` as
`preloaded` through `getMDXComponents`. No client-side filesystem read.

## Consequences

### Positive

- The docs value shipped independently of the migration that reverted once.
- `/docs/api/*` prerenders from server-bundled props — a small correctness win
  over v10's relative-path read at render time.
- The `openapi-fresh` gate remains the objective freshness contract; regeneration
  is deterministic.
- The reproduce-first discipline caught two real obstacles the hypothesis missed
  (below), so the fix targeted the actual failures.

### Negative / trade-offs

- **The bump is all-or-nothing.** core/ui and openapi move together; a future
  openapi bump will re-touch `api-page.tsx`, `page.tsx`, and the generator.
- **The generator no longer runs under `tsx`.** openapi 11 bundles its CJS deps
  (xml-js) as ESM copies under its own `dist/` with rolldown interop exports;
  tsx's esbuild loader mis-resolves those bundled `.pnpm` paths
  (`does not provide an export named 'require_js2xml'`), while Node's native ESM
  loader resolves them correctly. `generate:api-docs` therefore runs under `node`
  (native TS type-stripping). This is a standing tsx↔openapi-11 incompatibility
  to remember if the script grows or tsx is reintroduced.
- **openapi 11's Scalar playground peers are left uninstalled.** The new
  `@scalar/api-client-react` peer is optional; the static reference renders
  without it, and DorkOS does not adopt the interactive "send request" client.

### What the reproduction actually showed (O1, observed)

D6's direction was **confirmed** (APIPage is a client component in v11; the
file-path `document` prop model is gone), but the _first_ wall was a compile-time
API rename (`createAPIPage` → `createOpenAPIPage`), not the predicted prerender
read; and the generator↔tsx incompatibility was **not** predicted at all. Both
fixes landed inside the gate, so Phase B's done-ness was unchanged.
