---
slug: blintz-editor-polish
number: 260914-203800
created: 2026-09-14
status: specified
---

# Blintz markdown polish

**Author:** Codex, following `/flow`
**Tracker:** DOR-2038 — Polish Blintz markdown formatting and DorkOS theme integration

## 1) Intent & Assumptions

The user reports duplicate bullets, poor spacing, and incorrect DorkOS light/dark styling. They ask for a deep review, beautiful standalone and embedded formatting and functionality, permanent visual playgrounds, regression tests, dependency review, and completion through merged PRs and clean worktrees. They explicitly authorize independent design decisions, refactoring, features that support this goal, and delegated work across both repositories.

Assumptions:

- Correct Markdown semantics, readable typography, and predictable editing outrank ornamental additions.
- DorkOS owns its palette and font families. Blintz owns its prose geometry and editor controls.
- The same document must survive live theme changes with selection, edits, and undo history intact.
- Use one scoped task in the existing App Shell & Accessibility project. No new programme is required. Tasks below the configured XL threshold remain checklist entries.
- Work happens only in isolated worktrees. User authorization covers review, green CI, merges, and cleanup; it does not justify bypassing checks.
- Dependency upgrades must support a reproducible compatible editor build; avoid unrelated DorkOS dependency churn.

Out of scope: replacing the editing engine, adding collaboration, changing DorkOS persistence contracts, or redesigning unrelated app surfaces.

## 2) Pre-reading Log

- `AGENTS.md`: worktree isolation, accessible responsive UI, verification and merge gates.
- `/flow` triage, ideate, specify, decompose and tracker adapter: canonical spec/task files, durable tracker labels, marker-bearing comments, account-pinned calls.
- Blintz `packages/blintz/src/MarkdownEditor.tsx`, `useBlintzEditor.ts`, theme CSS and node views: multiple style systems currently compete.
- DorkOS `BlintzCanvas.tsx` and `blintz.css`: resolved theme is reactive, but host semantic colors and fonts are not mapped.
- Tracker: no open matching Blintz issue; DOR-420 is historical completed work. Blintz team has no existing issues.

## 3) Codebase Map

- Blintz `packages/blintz/src/theme/`: editor variables and node styles.
- Blintz `packages/blintz/src/features/`: custom list, code, image, table and empty-paragraph behavior.
- Blintz `apps/bakeoff/`: existing standalone comparison surface to evolve into a repeatable visual lab.
- DorkOS `apps/client/src/layers/shared/ui/BlintzCanvas.tsx`: shared boundary consumed by session canvas, files and room canvas.
- DorkOS `apps/client/src/layers/shared/ui/blintz.css`: package stylesheet and host theme bridge.
- DorkOS `apps/client/src/dev/`: Dev Playground routing, navigation and fixtures.
- DorkOS `apps/e2e/tests/dev-playground/`: real-browser coverage.

Data flow: Markdown string → Milkdown/ProseMirror document → React node views and CSS → edit transactions → Markdown serialization. The host supplies semantic colors and fonts; theme changes must update CSS without replacing the document.

## 4) Root Cause Analysis

At pinned Blintz revision `dc475053423ec4501f7471a30d9e2a5eb4c96063`, Nord supplies prose, global resets and OS-dependent colors; Crepe adds node views and separate colors; CodeMirror always uses One Dark. These layers disagree about list markers, spacing and theme ownership.

- The list node view produces invalid `ul > div > li` structure, while manual and native markers can both render.
- Fixed 32px marker labels ignore the prose baseline and tight-list rhythm.
- Theme defaults on descendants defeat inherited host overrides; broad ancestor selectors can choose a distant light ancestor over a nearer dark one.
- CodeMirror always uses One Dark, regardless of the host.
- Table node views lack a positioned overflow boundary.
- Task checkbox interaction is pointer-only; table controls lack useful labels; hover controls need keyboard and touch access.
- Read-only images still expose editing controls.
- Empty-paragraph cleanup removes legitimate inline `<br>` content.

DorkOS passes `data-theme` but maps none of its semantic HSL tokens or font families. Existing unit tests mock the editor and cannot observe its real appearance. There is no Markdown editor playground route. Initial screenshots confirm pale code surfaces in dark mode and weak syntax contrast in light mode.

## 5) Research

1. Patch over Nord from DorkOS: smallest immediate change, but preserves the competing style systems and leaves standalone defects. Rejected.
2. Replace the editor engine: large compatibility and serialization risk without evidence the engine is the problem. Rejected.
3. Give Blintz one scoped prose/theme system, retain compatible custom variables, and bridge host tokens explicitly: fixes the underlying ownership conflict and works in both repositories. Selected.

Compare the existing bakeoff editors and strong document-editor patterns for heading hierarchy, comfortable measure, list rhythm, code containment and unobtrusive controls. Such comparisons inform visual judgment; they do not justify changing Markdown semantics to imitate another product.

## 6) Decisions

| Decision            | Choice                                                                             | Rationale                                    |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| Styling ownership   | Scoped Blintz typography plus inherited host variables                             | Removes global/theme competition             |
| Lists               | Semantic `li` host and one deliberate marker                                       | Correct DOM, accessibility and visual rhythm |
| Theme switching     | CSS-variable update, no remount                                                    | Preserves document state                     |
| Code theme          | Variable-driven syntax palette                                                     | Readable in light, dark and custom hosts     |
| Visual evidence     | Real editor in both playgrounds                                                    | Mocks cannot detect CSS integration failures |
| Regression strategy | Semantic tests, computed browser assertions and approved screenshots               | Tests meaning and presentation together      |
| Compatibility       | Preserve existing `--crepe-*` customizations while documenting the public contract | Avoid unnecessary host breakage              |
| Dependencies        | Review and update deliberately, then consume a released package in DorkOS          | Avoid committed local links                  |

The user delegated these decisions. No unresolved product ambiguity prevents specification.
