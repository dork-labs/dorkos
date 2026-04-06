---
slug: marketplace-04-web-and-registry
number: 227
created: 2026-04-06
status: ideation
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 4
depends-on: [marketplace-01-foundation, marketplace-02-install]
linear-issue: null
tags: [marketplace, web, registry, content, telemetry]
---

# Marketplace 04: Web & Registry

**Slug:** marketplace-04-web-and-registry
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 4 of 5

---

## Source Material

- **Parent ideation:** [`specs/dorkos-marketplace/01-ideation.md`](../dorkos-marketplace/01-ideation.md)
- **Foundation spec:** [`specs/marketplace-01-foundation/02-specification.md`](../marketplace-01-foundation/02-specification.md)
- **Install spec:** [`specs/marketplace-02-install/02-specification.md`](../marketplace-02-install/02-specification.md)
- **Extension spec:** [`specs/marketplace-03-extension/02-specification.md`](../marketplace-03-extension/02-specification.md)

This spec depends on specs 01 and 02 implemented. Spec 03 ships in parallel — both 03 and 04 build on 02.

---

## Scope of This Spec

This spec produces **public discoverability and seed content**. It creates the `dorkos-community` GitHub organization and registry repo, ships the `/marketplace` web page on dorkos.dev, builds 5–10 seed packages (mix of Agents and plugins), and implements opt-in install telemetry that powers ranking and analytics.

After this spec ships, the marketplace is **publicly browseable** on the web, has **real content** people can install, and **tracks adoption** to feed the flywheel.

### In Scope

1. **`dorkos-community` GitHub org** — Public org hosting the registry and seed packages
2. **`dorkos-community/marketplace` repo** — Contains `marketplace.json` (the registry index)
3. **Seed package repos** (5–10 separate repos under `dorkos-community`):
   - **Agents** (Vision 1 — these are the headliners):
     - `dorkos-community/code-reviewer` — Reviews PRs, posts to Slack/Linear
     - `dorkos-community/security-auditor` — Weekly dependency + secret scans
     - `dorkos-community/docs-keeper` — Watches code changes, suggests doc updates
   - **Plugins:**
     - `dorkos-community/linear-integration` — Linear status extension + adapter
     - `dorkos-community/posthog-monitor` — PostHog dashboard + alerting
   - **Skill packs:**
     - `dorkos-community/security-audit-pack` — Tasks for dependency/secret/license checks
     - `dorkos-community/release-pack` — Tasks for version bumping, changelog, tagging
   - **Adapters:**
     - `dorkos-community/discord-adapter` — Discord relay bridge
     - (Telegram and Slack adapters already built-in to DorkOS)
4. **`/marketplace` web page on dorkos.dev** — Static SSG page reading from registry
5. **Per-package detail pages** — `/marketplace/[slug]` with README rendering
6. **Search & filter** — Same UX as Dork Hub but server-rendered
7. **OG images per package** — Auto-generated for sharing
8. **`llms.txt` integration** — Marketplace section for LLM discoverability
9. **Sitemap entries** — All marketplace pages indexed by search engines
10. **Submission process** — `CONTRIBUTING.md` in registry repo, GitHub Actions validation
11. **Install telemetry** — Opt-in, privacy-preserving metrics endpoint
12. **Ranking function** — Featured + install count + recency

### Out of Scope

- Foundation, install, or browse UI (Specs 01–03)
- MCP server (Spec 05)
- Personal marketplace publishing (Spec 05)
- Self-serve registry submission (v1 is PR-based)
- User accounts on dorkos.dev (deferred)
- Reviews/ratings (deferred)
- Sigstore signing (deferred)

---

## Resolved Decisions

| #   | Decision            | Choice                                                                            | Rationale                                                               |
| --- | ------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Registry hosting    | Static `marketplace.json` in `dorkos-community/marketplace` git repo              | Proven pattern (Claude Code, Codex). No infra. PR-based submissions.    |
| 2   | Submission process  | PR to `dorkos-community/marketplace` with GitHub Actions validation               | Quality control via review. Familiar workflow.                          |
| 3   | Web framework       | Existing Next.js 16 site (`apps/site`) with Fumadocs                              | Consistent with existing marketing site. SSG = fast.                    |
| 4   | Static vs dynamic   | SSG with hourly ISR revalidation                                                  | Fast TTI, fresh enough for content that changes weekly                  |
| 5   | Telemetry consent   | **Opt-in** (off by default)                                                       | Brand voice "honest by design". User trust over flywheel speed.         |
| 6   | Telemetry endpoint  | Vercel Edge Function on dorkos.dev                                                | Already on Vercel. No new infra.                                        |
| 7   | Telemetry storage   | Vercel KV (Upstash Redis) for counters; Vercel Postgres for events                | Minimal infra, scales linearly                                          |
| 8   | Ranking function    | Featured weight (manual curation) + log(install_count) + recency boost (last 30d) | Balanced — manual editorial + organic signal                            |
| 9   | OG image generation | `@vercel/og` (Satori) with templated layouts                                      | Existing pattern in `apps/site/src/app/features/[slug]/opengraph-image` |
| 10  | Seed agent count    | 3 agents + 2 plugins + 2 skill packs + 1 adapter = 8 packages                     | Enough variety to demonstrate; few enough to maintain                   |

---

## Acceptance Criteria

- [ ] `dorkos-community` GitHub org exists with marketplace repo
- [ ] `marketplace.json` validates against `MarketplaceJsonSchema` from spec 01
- [ ] All 8 seed package repos exist, each passing `dorkos package validate`
- [ ] `/marketplace` page on dorkos.dev renders package grid
- [ ] `/marketplace/[slug]` page renders for each package
- [ ] OG images generated for each package
- [ ] Sitemap includes all marketplace URLs
- [ ] `llms.txt` includes marketplace section
- [ ] Submission flow documented in CONTRIBUTING.md
- [ ] GitHub Actions validates new submissions
- [ ] Telemetry endpoint accepts install events
- [ ] Telemetry endpoint enforces opt-in
- [ ] Ranking function returns sorted package list
- [ ] DorkOS client respects user's telemetry consent setting
- [ ] All pages pass Lighthouse accessibility + performance audits
