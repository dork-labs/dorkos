---
slug: shared-design-system
number: 260923-144507
created: 2026-09-23
status: ideation
---

# One design system across DorkOS surfaces

**Slug:** shared-design-system
**Author:** Codex, from the operator's architecture discussion
**Date:** 2026-09-23

## 1) Intent & Assumptions

**Task brief:** Make the DorkOS client, Cloud account experience, and Community/Spaces feel consistent through shared styles, components, and interaction behavior. Determine which parts of the existing development playground should become a standalone design-system catalog. Support implementation while Cloud and Community continue evolving.

The operator asked for this ideation and supporting material so a separate agent can execute the work. This package completes IDEATE; it is not a frozen specification or evidence of implementation. Next stage: `/flow:specify` using this directory.

**User constraints:**

- All files, including planning and scratch files, belong in worktrees.
- Shared foundations belong in the public DorkOS repository; Cloud remains independently buildable in its own repository.
- Continue ongoing Cloud and Community feature development. Do not require a coordinated whole-product rewrite or deployment.
- Preserve the knowledge behind the recommendations for the next agent.

**Working assumptions:**

- Share foundations and generic interaction behavior; keep business rules, data fetching, authentication and application state with their applications.
- Use the existing client primitives as the initial extraction candidate because they encode established behavior. This is a recommendation, not a final decision on every component.
- Consistency allows different layout and density for operational screens, account forms, conversations and marketing pages.
- Package names, publication scope, release mechanics and catalog tooling remain specification decisions.

**Out of scope:** Backend changes; Cloud provisioning; cross-origin authentication; room protocol changes; a broad visual redesign; rewriting all primitives onto a different underlying library; a new community branding feature; a complete site migration in the first slice.

## 2) Pre-reading Log

- `AGENTS.md`: public/private boundary, FSD layering, independent builds and worktree rules.
- `contributing/design-system.md`: semantic colors, type, density, responsive controls and interaction principles. Currently anchored to client CSS.
- `contributing/styling-theming.md`: implementation conventions; reread at SPECIFY before freezing theme contracts.
- `apps/client/src/layers/shared/ui/button.tsx`: established size API, responsive sizes, reduced-motion-aware press behavior, safe form default and slotted-child behavior.
- `apps/client/src/index.css`: tokens coexist with application-specific styles and editor cascade ordering. Do not extract this entire file wholesale.
- `apps/community/src/browser/styles.css`: separate token vocabulary, green accent palette, custom control classes and media-query theme selection.
- `apps/client/src/dev/DevPlayground.tsx`: gallery shell also provides a mock transport, query client and router.
- `apps/client/src/dev/playground-providers.tsx`: feature examples rely on application transport and event-stream providers.
- `apps/client/src/dev/playground-pages.ts`: both generic foundations and feature simulations are registered here.
- `packages/icons/package.json`: existing shared icon package is private; cross-repository consumption needs an explicit packaging decision.
- `/flow` IDEATE template and command: untracked ideation is supported; tracker projection is optional until work is tracked.

Public source snapshot: `2f901e390b70b567370544e7bcad2e20a0dc00ae`. See [discovery](discovery.md) for reproducible evidence and tracker overlap. Private-repository evidence belongs in the temporary local handoff, not these public documents.

## 3) Codebase Map

| Area                    | Current home                        | Responsibility after extraction                          |
| ----------------------- | ----------------------------------- | -------------------------------------------------------- |
| Tokens and theme        | `apps/client/src/index.css`         | Generic tokens move; application styles stay             |
| Client primitives       | `apps/client/src/layers/shared/ui/` | Pure primitives move; domain-aware components stay       |
| Client feature examples | `apps/client/src/dev/`              | Retain app providers and simulations locally             |
| Community browser       | `apps/community/src/browser/`       | Consume foundations; retain membership and room behavior |
| Icons                   | `packages/icons/`                   | Reuse rather than create another registry                |
| Design guidance         | `contributing/design-system.md`     | Explain cross-surface contract and intentional variation |

**Proposed dependency direction:** tokens → UI → consuming apps and catalog. These arrows mean "is consumed by". No package imports an app. The catalog consumes the real UI exports. Cloud consumes versioned public releases; client and Community use workspace dependencies. No shared UI package imports server code, a DorkOS transport, a router singleton or credentials.

Proposed folders: `packages/design-tokens`, `packages/ui`, `apps/design-system`. These do not exist as a result of this ideation. A CSS export within the UI package is a viable alternative to a separate tokens package if separate versioning has no value.

**Blast radius:** rendered DOM and labels, keyboard behavior, touch targets, dark mode, CSS order, all consumers' builds, FSD imports, component tests, showcase registries, screenshot coverage, desktop and embedded client styles, package release tooling.

## 5) Research

| Approach                           | Benefit                                   | Cost / limitation                                                   |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Guidelines only                    | Minimal packaging work                    | Implementations continue drifting independently                     |
| Shared tokens only                 | Aligns visual vocabulary early            | Does not share accessibility or interaction fixes                   |
| Shared tokens and React primitives | One maintained implementation per control | Requires stable exports, consumer tests and release discipline      |
| Copy components into each app      | Local flexibility                         | Recreates the current divergence                                    |
| Move the entire playground         | One apparent destination                  | Pulls app-specific state and feature dependencies into a shared app |

**Recommendation:** shared tokens and pure primitives, an independently runnable catalog for those primitives, and local feature playgrounds for app-specific states. Extract incrementally, beginning with tokens, Button, Field/Input and a generic Notice pattern on one real screen in each primary surface.

Select screens during specification after checking active work and dependency graphs. A component being under `shared/ui` is not sufficient proof that it is portable. Do not assume a generic Notice export already exists or extract the marketplace-specific notice as one.

Choose one component foundation deliberately. Preserve client behavior during extraction; avoid coupling it to an unrelated primitive-library migration. The next agent must evaluate complex dialogs, menus, portals and composition APIs before finalizing that choice.

Styles are part of the package contract. Tailwind excludes dependency directories from automatic scanning; document explicit source registration or ship compiled component CSS. Test the actual packed artifact outside the monorepo, not just workspace imports. Reference: [Tailwind source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files).

## 6) Decisions

| Decision                                       | Status                           | Rationale                                                                   |
| ---------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Consistency across client, Cloud and Community | User goal                        | Connected experiences should share visual and behavioral foundations        |
| All writes in worktrees                        | User requirement                 | Other agents use the integration checkouts                                  |
| Separate agent performs implementation         | User requirement                 | This delivery is the knowledge-transfer package                             |
| Shared packages plus split playground          | Recommended direction            | Reuses behavior without coupling applications                               |
| Client primitives as extraction baseline       | Recommended, validate in SPECIFY | Preserve accumulated interaction fixes                                      |
| Versioned public packages consumed by Cloud    | Recommended                      | Independent repository and deployment boundaries                            |
| Defer creating Linear project until SPECIFY    | Recommendation for this handoff  | Confirm ownership, first slice and overlap before scheduling implementation |

No tracker project, issue or implementation task was created in this stage. Target project name: **DorkOS Shared Design System**. At SPECIFY, search again for an existing equivalent project, create or reuse the appropriate home, and establish an umbrella before DECOMPOSE creates executable work. Keep private Cloud implementation details in its own tracker/repository. Do not mark IDEATE artifacts as implementation complete.

## 7) Open Decisions and Exit Criteria

SPECIFY must settle package boundaries/names, public export shape, CSS delivery, primitive foundation, theme activation and defaults, supported React/Tailwind versions, icon packaging, catalog tooling, selected pilot screens and migration ownership. These are bounded engineering decisions; use evidence and record assumptions instead of reopening the agreed goal.

Finish specification with measurable acceptance criteria, a proposed ADR, a compatibility/release plan, and a phase dependency graph. Then use DECOMPOSE and EXECUTE. Preserve human review gates from the current flow configuration; this document grants no exception for paid services or publishing permissions.

Supporting documents: [discovery and overlap](discovery.md), [migration and verification](migration-plan.md).
