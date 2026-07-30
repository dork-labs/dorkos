---
slug: connections-redesign
id: 260729-234751
created: 2026-07-29
status: ideation
---

# Connections redesign — the catalog becomes the page, and the copy stops flinching

**Author:** spec-redesign (connections-redesign program)
**Date:** 2026-07-29
**Basis:** the design critique at `connections-ux-critique.md` (round 1, 2026-07-29), source read of the shipped surface the same day, `specs/connector-completion/02-specification.md` (implemented), PR #617 (`dd7647cb9`).
**Sibling spec (parallel, dependency):** `specs/direct-connect` — real OAuth for direct connections plus the built-in direct catalog (critique P0b + P1). This spec is UX; that spec is the platform.

## The problem, in one screenshot

`/connections` at 1440×900, first run: a 180px empty box labelled "Services", one gray sentence labelled "Connected accounts", and — below both — the only two buttons on the page, sitting under two vendor names nobody outside this repo can choose between. The two empty states point at each other. The topbar says "Dashboard". On a phone the only control is roughly 700px below the fold, under the same two dead sections.

Two interactive elements in the entire main content. A control panel with nothing to control.

## What already shipped (correcting the critique where it went stale)

The critique's P0 items landed in PR #617 (`dd7647cb9`) before this spec was written. Verified in source:

| Critique claim                                           | Status now                                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listToolkits`/`listAccounts` swallow failures into `[]` | **Fixed.** Both propagate; `registry._aggregate` turns the rejection into a per-provider `warnings[]` entry, and the grid already renders those verbatim.                                            |
| "Ready" means "we have a string"                         | **Fixed.** The bootstrapper probes each provider with one authenticated read before registering. A rejected key leaves `registered: false` with the vendor's own message verbatim on the status DTO. |
| The false comment at `composio.ts:144-146`               | **Deleted.** The module doc now states the propagate contract per method.                                                                                                                            |
| `recommendForRoles` "does not exist"                     | **Wrong — it ships.** `packages/shared/src/profile-recommendations.ts` exports `ROLE_CANON`, `ROLE_RECOMMENDATIONS`, `normalizeRole`, and `recommendForRoles`, already consumed by onboarding.       |

So the honesty floor is in place, and the try-it-now beat has a real role signal to key off. What has **not** changed: the page's shape, its copy, its discovery, and the fact that a person with a working key and zero accounts still meets an empty box.

## Scope: P2 + P3 + P4 + P6, plus the import beat

Five outcomes, all UX:

1. **P2 — invert the page around the catalog.** The catalog is the page. It is populated on a fresh install with no key, because it is curated data in the client, not a provider read. Each tile carries a brand mark, one plain sentence of what an agent will be able to do, a **custody chip** that is always true, and a **capability facet** (Read-only / Read & write / Interactive). Providers leave the top level for a collapsed Advanced disclosure. The breadcrumb, the mobile fold, and the circular empty-state copy go with it.
2. **P3 — honest copy.** Name Composio one beat before Google's consent screen names it. Stop asserting a Nango server the reader does not have. Walk the person to the right Composio key, because the founder pasted the wrong kind and the API answered 401 for three minutes.
3. **P4 — chat as front door.** The seven connector tools ship. What is missing is that nobody knows. Fix the two tool descriptions that point at a "Settings → Connections" screen that does not exist, teach DorkBot to volunteer the capability, let the session readout say "nothing connected yet" in the one place a person opened on purpose, and cross-link the page back to chat.
4. **P6 — try-it-now.** One tap after a successful connect: a session opens with the account attached and the composer prefilled with a curated, role-aware prompt. All three primitives verified present in source.
5. **Import what is already there.** The founder's Composio project already holds connected accounts. DorkOS scopes its own reads to `user_id: 'dorkos-operator'`, so those accounts are invisible. Offer them, disclose custody, and be honest when adoption cannot reach their tools.

Out of scope, deliberately: the OAuth/direct-connect platform (`specs/direct-connect`), attachment durability (critique P5 — until attachments survive a restart, nothing here offers "attach by default"), and any pricing number in any string.

## Founder decisions, baked in (not reopened)

| #   | Decision                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The fourth custody class is named **"Direct — the key stays on your machine."** Chip label: `Direct`.                                    |
| 2   | The **DorkOS-held platform key is dead.** No shared vendor credential, ever. Nothing in this spec assumes one.                           |
| 3   | Composio disclosure is **plainly forward**: the UI names Composio one beat before the vendor consent screen does.                        |
| 4   | **No pricing numbers in the UI.** Rates change 2026-08-15. Link out instead.                                                             |
| 5   | Try-it-now prompts come from a **curated per-service map**, selected by the shipped `recommendForRoles`.                                 |
| 6   | **Slack is never in a direct catalog.** Slack's tile routes to the Relay adapter, which `recommendConnector` already ranks first for it. |

## The shape we chose, and the two we rejected

**Chosen: curated catalog in the client, live truth layered on top.**
The tile names, marks, capability sentences and facets are static data in `layers/features/connections/config/`. The custody chip and the connected state come from live server data. This is the only shape where a fresh install with no key still shows fourteen real services, and where every claim on a tile is either local fact or live fact — never an inference.

**Rejected: derive the catalog from `GET /api/connectors/toolkits`.** That is what ships, and it is why the page is empty. The list is provider-derived, so it is empty until a key works, carries no marks, no descriptions, and no categories, and the long tail (hundreds of Composio toolkits) is unrankable. It stays in the page as a secondary "More services" list, which is exactly what it is good for.

**Rejected: `connectors.rawMcpServers` as the catalog source.** Boot-read-only, no display metadata (connector-completion OQ3). It remains the user-extension escape hatch, documented in Advanced.

## The one structural decision worth arguing about

A per-tile custody chip has to be **true**, and the shipped toolkit DTO cannot make it true: `ConnectorToolkitSchema` is `{ slug, displayName, authKind, maxAccountsPerUser }`, deduped across providers, so which provider (and therefore which custody stance) would carry a service is lost by the time the client sees it. Two ways out:

- **Infer** from "a managed provider is configured" → the chip guesses, and guesses wrong the moment both Composio and a self-hosted Nango are configured. Unacceptable on a surface whose whole subject is custody.
- **Carry it** — add `custody` to the aggregated toolkit DTO, set from the yielding provider's capabilities during aggregation, deduped by the same managed-over-self-host precedence `recommendConnector` already uses (~30 lines, `registry.ts` + one Zod field).

We carry it. And when no live route exists at all, the chip says `Needs setup` and names no vendor — a claim that cannot be wrong.

## Risks

| Risk                                                                                                                                                                      | Response                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brand marks** for Gmail, Notion, Linear, GitHub do not exist in `@dorkos/icons`, and shipping them has a trademark question open (critique founder decision #1).        | The catalog renders a mark when the registry has one and a neutral service glyph when it does not. No tile depends on a mark existing. Marks land as a separate, unblocking task. |
| **Composio's unfiltered account list** may need a scope the project key lacks, and an adopted account may live under a different `user_id`, so its tools may not resolve. | Adoption probes tool reachability immediately and says so. The fallback ("connect it again through DorkOS") is one click and always works.                                        |
| The shipped Playwright suite drives the provider card on the top level.                                                                                                   | The suite moves with the card: it opens Advanced first. Same assertions, one extra click, called out in the task's acceptance criteria.                                           |
| A "materialize" animation on a surface that used to lie was explicitly argued against.                                                                                    | One restrained animation, gated to a truthful state, and reduced-motion gets a persistent "Just connected" marker instead of losing the feedback.                                 |

## Open questions carried into the spec

1. Composio's API-keys deep link and the exact "project key, not CLI key" wording — verify the URL live at EXECUTE.
2. Whether the unfiltered Composio account read works on a project key (the import beat's only load-bearing assumption).
3. Whether the `Direct` chip appears at all in this spec's release, which depends on `specs/direct-connect` landing first. The catalog reads an empty direct set gracefully, so ordering is free.
