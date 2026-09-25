---
slug: obsidian-retirement
id: 260925-192121
created: 2026-09-25
status: specified
---

# Retire the Obsidian plugin

## Intent & assumptions

The operator authorizes removal of the unused, under-tested Obsidian surface and its exclusive maintenance paths, through independent review, merge queue delivery and safe cleanup. DOR-2343 tracks the complete outcome. This is a detailed retirement brief, adapted directly into specification rather than re-opening the product decision.

The operator's lack of use does not prove there are no external users. Preserve migration guidance and history. No replacement plugin, obsolete binary publication, archive repository, paid evals or live deployment is in scope.

## Pre-reading and codebase map

- `AGENTS.md`, `REVIEW.md`: preserve supported behavior, isolate every writer, review a pushed branch before opening a PR.
- Installed `/flow` configuration validates; configured tracker transport is CLI, account `dorkos`, team DOR. No tracker account is inferred from an unrelated session.
- `apps/obsidian-plugin`: host UI, note context and in-process server bundling.
- `apps/client`: DirectTransport, embedded shell and context state have plugin-only live consumers; HTTP, desktop and Dev Playground remain.
- `packages/ui`: active shared UI adoption is independently owned. Preserve portable functionality and reconcile guide changes.
- `docs/guides/obsidian-plugin.mdx`: retain the public URL as retirement guidance.

## Research

The docs census found no matching Obsidian assets in the repository's GitHub release inventory, no matching entry in the official community-plugin registry, and no matching repository issue titles. Source-built external usage remains unknown. Keep these evidence limits explicit.

## Decisions

| Decision   | Choice                                                       | Reason                                                            |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Retirement | Remove active plugin and exclusive branches                  | Authorized focus on supported surfaces                            |
| Recovery   | Exact Git commit and tree, separate historical checkout      | Recoverable without publishing an obsolete binary                 |
| Migration  | Normal app opened on vault folder under ordinary permissions | Markdown remains usable; no active-note parity claim              |
| Shared UI  | Retain portable primitives and supported host tokens         | Other surfaces consume them                                       |
| Delivery   | One integrated PR after independent review                   | Atomic deletion and reference reconciliation                      |
| Isolation  | All artifacts in task worktrees                              | Explicit operator instruction overrides intent-stage main default |
