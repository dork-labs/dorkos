---
slug: blintz-editor-polish
number: 260914-203800
created: 2026-09-14
status: specified
---

# Blintz markdown polish

**Status:** Review-ready; verification passed, final pushed review/CI/merge pending
**Author:** Codex
**Date:** 2026-09-14
**Tracker:** DOR-2038 — Polish Blintz markdown formatting and DorkOS theme integration

## Overview

Establish one coherent formatting and theme system for Blintz, then connect it to DorkOS semantic tokens. Ship real-editor playgrounds and browser regressions in both repositories. Completion requires visual acceptance, preserved editing behavior, reviewed green PRs, merged changes, and removal of clean task worktrees.

## Background / Problem Statement

Nord prose and global styles, Crepe node styles, and a fixed One Dark CodeMirror theme compete. Invalid list DOM enables duplicate markers. Descendant defaults prevent host customization, and ancestor theme selectors can disagree with the closest host. DorkOS sets the resolved theme but provides no semantic token bridge. Existing mocked wrapper tests cannot expose these failures.

## Goals

- Exactly one aligned marker for unordered, ordered and task items; preserve nesting and ordered-list starts.
- Deliberate heading hierarchy, paragraph rhythm, block spacing and readable content measure.
- Consistent light/dark/custom-host colors for every text and control surface, including syntax highlighting.
- Live theme changes preserve editor identity, content, selection and undo history.
- Responsive tables, code, images and controls remain usable in narrow panes and mobile layouts.
- Accessible editing controls and truthful read-only behavior.
- Preserve Markdown content, including inline hard breaks.
- Reproducible standalone and DorkOS visual/behavioral regressions, backed by reviewed dependency versions.

## Non-Goals

No engine replacement, collaboration model, persistence rewrite, unrelated DorkOS redesign, or broad dependency migration.

## Technical Dependencies

Retain React, Milkdown/ProseMirror and CodeMirror. Review the installed dependency graph and compatible available versions during execution. Remove dependencies made obsolete by the consolidated theme, such as Nord and fixed One Dark when their imports are removed. DorkOS must consume a published compatible Blintz version; temporary local packages are allowed only for verification and must not survive in committed manifests or lockfiles.

## Detailed Design

### Blintz formatting and theme

Remove Nord setup/imports and replace them with a scoped reset and prose stylesheet. Style headings, paragraphs, emphasis, strike, links, rules, quotes, lists, inline code, fenced code, images and tables explicitly within the editor boundary. Avoid global body, button, list or typography resets.

Use semantic list-item node-view hosts. A list item must be a direct `li` child of `ul` or `ol`, including nested lists. Choose one custom marker and suppress native duplication. Align the marker to the first text baseline; define compact adjacent items and deliberate nested/loose-list rhythm. Preserve ordered starts, numbering and task state through serialization.

Provide an inherited public theme-variable contract and explicit local theme control. Existing `--crepe-*` customizations remain usable. A host override must reach descendants without fighting editor defaults. The nearest explicit editor theme wins over distant ancestors and OS preference. Replace fixed code colors with variables covering code surface, ordinary code text and meaningful syntax token groups.

Give tables a positioned horizontal overflow wrapper that contains a wide table without expanding the page. Provide useful labels for table controls, visible focus, and controls reachable without hover. Images and code must also respect the pane width.

Task checkboxes support keyboard activation and expose state and a usable accessible name. Read-only images show captions as text and omit editing/upload controls. Inline `<br>` survives parsing/serialization; cleanup may remove only the legacy standalone empty-paragraph artifacts it was intended to remove.

### DorkOS boundary

Keep one shared `BlintzCanvas` boundary for all current consumers. Map DorkOS semantic foreground, background, muted, border, accent, selection and font tokens to editor variables in scoped `blintz.css`. The existing reactive resolved theme remains the authority. Theme switching must not use a React key or replace the editor instance.

Add `/dev/markdown` using the real `BlintzCanvas`, with a full reading specimen, editable specimen with observable source output, narrow-panel specimen and empty-state specimen. Register the route and navigation through existing Dev Playground conventions.

### Standalone visual lab

Evolve the existing bakeoff app into a reliable playground. Include comprehensive, deterministic Markdown fixtures; light/dark switching; read-only and editing paths; narrow layout coverage; and a comparison surface where useful. Do not require a backend, remote images or paid services for regression tests. Add documented browser commands and CI coverage appropriate to the repository.

### API and data model

No DorkOS transport or persistence changes. Any additive Blintz theme API must be documented with inheritance and precedence examples. Markdown remains the interchange format.

## User Experience

Opening a Markdown file gives the user a readable document that belongs to its host app. Switching app theme recolors prose, code, tables and controls immediately, including an open editing session. Lists have one consistent marker and clear nesting. Long tables scroll inside the editor. Keyboard users can operate tasks and editing tools. Read-only documents do not advertise unavailable editing actions.

## Testing Strategy

Use semantic unit tests for parsing, serialization and node-view behavior. Browser tests must mount the real editor and inspect computed styles/geometry; mock only external transport or deterministic data seams. Screenshot baselines are reviewed evidence, not blindly refreshed acceptance. Every test should explain the failure it protects against.

| Area              | Required regression and visual acceptance                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown specimen | H1–H6, paragraphs, strong/emphasis/strike, links, rules, quotes, inline code, fenced code, image/caption, tables, ordered/unordered/task/nested/loose lists |
| List structure    | Direct semantic `li` children, exactly one marker, ordered start preserved, task state round-trips, marker baseline and nested spacing                      |
| Theme             | Explicit light and dark; host light with OS dark and host dark with OS light; nearest explicit theme precedence; custom ancestor variables                  |
| Live switching    | Same editor DOM/instance, unchanged Markdown, selection retained and undo still functional after a light → dark → light cycle                               |
| Colors            | Real prose/headings/link/inline-code/syntax/control computed colors follow host semantics; no pale dark-mode code slab or low-contrast light syntax         |
| Responsive        | Desktop and narrow/mobile specimens; wide table scrolls locally; no unexpected document overflow; image and code fit                                        |
| Editing           | Type, format, task toggle, selection toolbar and representative table/image controls; serialized source reflects changes                                    |
| Accessibility     | Task keyboard activation, useful control labels, visible focus, focus/touch access to otherwise hover-only tools                                            |
| Read-only         | No editable image caption or upload controls; content remains readable                                                                                      |
| Hard breaks       | Inline `<br>` retained while standalone legacy empty artifacts are removed                                                                                  |
| Host coverage     | Standalone playground plus actual shared DorkOS wrapper used by session/file/room consumers                                                                 |

Run targeted tests while iterating, then package build/typecheck and required repository gates. Re-run relevant browser evidence against the final released dependency before merging DorkOS.

## Performance Considerations

Theme changes use CSS rather than rebuilding editors. Keep prose selectors scoped and simple. Playground fixtures are deterministic and bounded. Avoid expensive screenshot matrices for equivalent cases when computed-style/semantic tests provide a stronger cheaper oracle; retain representative desktop/mobile visual snapshots.

## Security Considerations

Retain existing Markdown/link/image sanitization. Do not weaken URL handling for fixtures or add network credentials. Test fixtures use local or embedded assets. Package installation and publication follow repository policy; no secrets are committed.

## Documentation

Document the Blintz theme contract, standalone browser commands and baseline-review workflow. Document/register the DorkOS playground page and its tests. Add the applicable human-readable release notes. Keep canonical task status and verification evidence with this specification and its tracker issue.

## Implementation Phases

1. Consolidate Blintz prose/theme ownership; repair semantic list and content-fidelity defects.
2. Add the DorkOS token bridge/playground and standalone visual lab/regression harness in parallel within separate file ownership.
3. Review dependencies, run full visual/behavioral matrix, iterate on observed defects, and gather evidence.
4. Independently review and merge Blintz, release its package, verify DorkOS against that package, merge DorkOS, then close tracking and remove clean worktrees.

## Open Questions

- ~~Should ordinary skill approval pauses stop this work?~~ **RESOLVED:** No. The user expressly delegated design decisions and authorized completion through merged PRs. Required checks and independent review still apply.
- ~~Should the host patch over the existing theme?~~ **RESOLVED:** Consolidate the library theme and bridge host tokens. This fixes standalone and embedded behavior at the correct boundaries.
- ~~Should this create a new project?~~ **RESOLVED:** Use the existing App Shell & Accessibility project and one scoped task. No new programme is needed.

## Related ADRs

The existing shared-wrapper/FSD boundary is retained. The theme consolidation removes competing defaults and documents an existing CSS customization seam; it does not introduce a new application architectural port or persistence decision, so no new ADR is required.

## References

- `specs/blintz-editor-polish/01-ideation.md`
- `specs/blintz-editor-polish/03-tasks.json`
- DOR-2038; historical DOR-420
- Blintz pinned audit revision: `dc475053423ec4501f7471a30d9e2a5eb4c96063`
- DorkOS pinned base: `786a3df6637cbdcfba23992e35747e39b7bd49fc`
