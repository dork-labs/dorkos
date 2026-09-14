# Blintz implementation and verification record

**Tracker:** DOR-2038 — Polish Blintz markdown formatting and DorkOS theme integration
**Updated:** 2026-09-14
**State:** Review-ready. Final rebased DorkOS verification and public-package acceptance passed. Blintz has merged and 0.5.0 is publicly released. Exact pushed-revision host review, PR CI, DorkOS merge and cleanup remain pending; the combined task is not Done.

This record distinguishes implemented behavior from final acceptance. The coordinating agent owns source changes and Git operations. The task has entered VERIFY after the interaction fixes and local browser matrix passed. Final Blintz independent review and release gates have cleared; published-package DorkOS acceptance has passed; authoritative whole-repository verification after rebase has passed. Final pushed host review remains open. Nothing in this record marks the work Done.

## Delivered scope

### Blintz

- Replaced Nord prose/global styles with scoped typography and a reset owned by Blintz.
- Added inherited public `--blintz-*` host variables, with legacy `--crepe-*` compatibility. Explicit local theme control and CSS-driven updates preserve editor state.
- Replaced fixed One Dark code rendering with theme-variable surfaces, text and syntax colors.
- Repaired list node-view semantics, duplicate markers, marker alignment, tight/nested/loose spacing and ordered starts. Also resolved a host Tailwind `.list-item` utility collision discovered during embedded testing.
- Made task controls keyboard operable and gave editing controls useful names and focus behavior.
- Added contained wide-table scrolling and keyboard-operable table menus.
- Removed image editing/upload controls from read-only views and rendered captions as text.
- Preserved intentional inline hard breaks, including a heading hard-break data-loss case discovered during review.
- Removed phantom spacing caused by the virtual cursor element.
- Fixed slash-keyboard and selection-toolbar races; repeated keyboard checks passed 20/20.
- Corrected placeholder contrast during final review and added coverage for it.
- Resolved duplicate ProseMirror runtime classes in the host through precise dependency overrides, protecting real image-caption interaction.
- Added standalone specimen/playground views, Markdown source editing, deterministic local media, a comparison surface, browser tests, screenshot baselines and a verification workflow.

The implementation covers all eight initial audit findings. Additional fixes above came from real browser behavior and independent review within the authorized editor scope.

### DorkOS

- Added a semantic color/font bridge at the shared `BlintzCanvas` boundary, using the public host-variable contract.
- Kept session canvas, file and room Markdown consumers on the shared editor boundary.
- Added `/dev/markdown` with real reading, editing/source, narrow and empty specimens, plus the normal Dev Playground navigation registrations.
- Added browser assertions for computed colors, theme switching, list semantics/geometry and responsive containment using the real editor.
- Grouped content playground pages and sections under `content` to respect directory-size rules; 54 mount/registry checks pass.

### Dependencies

The library is published as **0.5.0** on npm and GitHub. Milkdown, React, the ProseMirror React bridge, CodeMirror and related dependencies were reviewed and updated. Nord and the direct One Dark dependency were removed. Vitest is pinned exactly to **4.1.11**, fixing the remaining audit finding without taking the newer major's Node/runtime migration.

The dependency pass verified ordinary `npm ci`, `npm dedupe`, a typecheck of the root Vitest configuration, and an audit with zero reported vulnerabilities. npm 10.9.7 initially crashed inside Arborist's optional-peer resolution; regenerating the lock with npm 11.19.1 repaired it. Subsequent ordinary npm 10 install checks passed without `--force` or `--legacy-peer-deps`.

One Dark remains installed transitively because upstream `@milkdown/react` depends on `@milkdown/crepe`, which depends on One Dark. This is an upstream dependency, not a stale direct declaration; Blintz source does not import or apply that theme. Removing that upstream graph would require changing the React wrapper dependency and is unnecessary for the formatting fix.

## Visual decisions and evidence

The coordinating agent reviewed side-by-side Blintz, BlockNote and MDXEditor captures. Blintz deliberately keeps a restrained 32px first-level heading instead of BlockNote's 48px presentation, compact readable list spacing, consistent palette and quiet controls. The comparison informed hierarchy and rhythm without changing Markdown semantics to imitate another editor.

Durable evidence is attached to the [Blintz 0.5.0 release](https://github.com/dork-labs/blintz/releases/tag/v0.5.0): [visual-review.zip](https://github.com/dork-labs/blintz/releases/download/v0.5.0/visual-review.zip). The following `/tmp/blintz-review/` paths identify the original session captures and diagnostics:

| Evidence                                       | Files                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Original standalone defects                    | `baseline-light.png`, `baseline-dark.png`                                       |
| Original embedded appearance                   | `dorkos-baseline-light.png`, `dorkos-baseline-dark.png`                         |
| Comparisons reviewed by coordinator            | `comparison-blintz.png`, `comparison-blocknote.png`, `comparison-mdxeditor.png` |
| DorkOS reading                                 | `dorkos-reading-light.png`, `dorkos-reading-dark.png`                           |
| DorkOS editing                                 | `dorkos-editing-light.png`, `dorkos-editing-dark.png`                           |
| DorkOS narrow pane                             | `dorkos-narrow-light.png`, `dorkos-narrow-dark.png`                             |
| DorkOS actual canvas                           | `dorkos-canvas-light.png`, `dorkos-canvas-dark.png`                             |
| Interactive controls                           | `slash-light.png`, `toolbar-light.png`, `dorkos-toolbar-light.png`              |
| Current package preview                        | `blintz-preview-5.tgz`, version 0.5.0                                           |
| Current package build and packed-file evidence | `package-build4.txt`; packed-file evidence remains local                        |

Durable temporal recordings, uploaded and checked for expected sizes and durations:

- [DorkOS Markdown theme switching — 10.84s](https://github.com/dork-labs/blintz/releases/download/v0.5.0/dorkos-markdown-themes.webm)
- [DorkOS draft editing — 10.8s](https://github.com/dork-labs/blintz/releases/download/v0.5.0/dorkos-markdown-draft.webm)
- [Blintz writing-room themes — 10.64s](https://github.com/dork-labs/blintz/releases/download/v0.5.0/blintz-writing-room-themes.webm)

The evidence-selection oracle used the configured `ui: auto`, `temporal: video`, and PR/tracker attachment policy with a live session. It selected an annotated GIF for UI evidence and WebM for temporal behavior. No callable GIF-creator capability was found, so the documented fallback is reviewed UI stills plus the configured WebM recordings. Representative frames and durations were reviewed; no GIF is claimed. All four durable evidence links are attached to DOR-2038.

Standalone approved screenshot baselines are committed under `browser-tests/editor.spec.ts-snapshots/` in Blintz, covering typography, lists, technical content, media and overview specimens in both themes at desktop and phone sizes. The final Blintz browser run and independent review passed. DorkOS public-package acceptance and final verification on the refreshed base have also passed.

Reference material consulted by the coordinating agent: [Milkdown Crepe API](https://milkdown.dev/docs/api/crepe) and [Notion writing and editing basics](https://www.notion.com/help/writing-and-editing-basics).

## Verification ledger

| Check                                  | Current evidence                                                                                                                                                                                                                    | Final gate status                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Blintz package build                   | `package-build4.txt` shows successful Vite build and declarations                                                                                                                                                                   | Passed locally                                             |
| Package typecheck and unit regressions | Coordinator reports fresh all-workspace typecheck and 41 unit tests passing                                                                                                                                                         | Passed locally; final Blintz independent review cleared    |
| Table and editor keyboard checks       | Included in the passing browser run; coordinator reports keyboard repetitions 20/20                                                                                                                                                 | Passed locally                                             |
| Full standalone browser matrix         | Coordinator reports final 50 browser tests passing after placeholder-contrast coverage; previous 48-test run remains local evidence                                                                                                 | Passed locally                                             |
| DorkOS browser matrix                  | Official npm `blintz@^0.5.0`: 6/6 browser checks pass in 19.7s with zero page errors, including image captions after ProseMirror dependency alignment                                                                               | Public-package acceptance passed                           |
| DorkOS focused checks                  | 57 targeted unit tests, client typecheck, formatting and whitespace checks pass against the public package                                                                                                                          | Passed                                                     |
| Dependency install/audit               | Clean ci/dedupe; `npm-audit-final.json` contains zero findings                                                                                                                                                                      | Passed locally                                             |
| Independent adversarial review         | Blintz final revision `1bcf067cf6173274ef77df69be84c124b40f3dba` independently cleared                                                                                                                                              | Passed for this Blintz revision; host final review pending |
| Required repository gates              | Final `pnpm verify` completed with exit 0 under Node 24.14.1 on the rebased public-package tree. Final test phase: 34/34 tasks successful, 28 cached; server 18,622 passes, client 15,351 passes, desktop 790, CLI 897, Obsidian 87 | Passed; supersedes interrupted preview run                 |
| Published package consumption          | Official npm `blintz@^0.5.0` installed in DorkOS with matching release integrity; no preview dependency remains                                                                                                                     | Passed                                                     |
| PR CI and merge                        | [Blintz PR #1](https://github.com/dork-labs/blintz/pull/1) merged as `27c9079d82d07ea5f7eb913d74a38c11a6633f6c` after final CI passed                                                                                               | Blintz complete; DorkOS PR/CI/merge and cleanup pending    |

`browser-final-generation.log` preserves the earlier 44-pass/4-failure diagnostic run. Its slash/selection interaction failures were fixed; `browser-final.log` superseded it with 48 passing tests without a baseline update. A later placeholder-contrast fix and coverage bring the final coordinator-reported browser result to 50 passes. `npm-audit.json` is likewise a pre-upgrade baseline; `npm-audit-final.json` supersedes it with zero findings. Keep diagnostics and final results clearly distinguished. Preview tarballs and local dependency paths must not remain in committed DorkOS manifests or lockfiles.

Blintz's independently cleared source revision was `1bcf067cf6173274ef77df69be84c124b40f3dba`. [PR #1](https://github.com/dork-labs/blintz/pull/1) merged as `27c9079d82d07ea5f7eb913d74a38c11a6633f6c` after final CI passed, and [0.5.0](https://github.com/dork-labs/blintz/releases/tag/v0.5.0) is published. Registry and [GitHub package asset](https://github.com/dork-labs/blintz/releases/download/v0.5.0/blintz-0.5.0.tgz) integrity match:

```text
sha512-uBxPrXxciCk3mYHfeLFy8oel+2Hga38SpvM9FnNjeZ9bEoUja0syIxHoW2ZgkCHb+lALB8gXD683QpJ+aRVfdA==
```

DorkOS now consumes the official npm `blintz@^0.5.0` package with verified integrity. All six host browser checks passed in 19.7s with zero page errors; 57 targeted unit tests, client typecheck, formatting and whitespace checks also passed. Empty-state light/dark captures were visually inspected. The final host base is `0d5d7eb1e313fe1782c5108a445a7d1bf3a34c27` (release 0.75). Final `pnpm verify` exited 0 under Node 24.14.1 and supersedes the deliberately interrupted preview run. The final test phase reports 34 successful tasks out of 34, with 28 cached. The full log is `/tmp/blintz-review/dorkos-final-verify.log`. The verified source revision before this evidence-only amendment is `6f973e229621c1a98b48ecd37cc171c4bd2120be`. Exact pushed-revision review after amendment, CI, merge and cleanup are still required.

## VERIFY and final-review record

Final pre-merge requirements:

1. Pin each repository's final base/head SHA and record its PR URL once available.
2. Read complete final package/host verification results, including both explicit themes, opposite OS scheme cases, desktop/narrow layout, editing, hard breaks, lists, tables, read-only controls and live-theme state preservation.
3. Obtain the independent review's final disposition after all corrections. Review the pushed branch before opening its PR.
4. Attach durable visual/test evidence to the issue and PR; distinguish representative screenshots from automated assertions.
5. Blintz merge/release, public-package host acceptance and final whole-repository verification on the refreshed base are complete. Keep the final pushed revision tied to this evidence.
6. Let required CI and review gates decide merge readiness. Mark DONE only after both merges, relevant followups and clean task-worktree removal.

## Assumption trail and recovery pointers

- The user explicitly authorizes independent product decisions, worktree-only changes, delegation, dependency updates, continued visual iteration, green reviewed merges and cleanup. Ordinary skill approval pauses are satisfied by that mandate; verification and review remain required.
- All tracker activity uses the adapter and the user-required personal account. Identity was verified before writes; no credential values are stored in these artifacts.
- One DOR task in the existing App Shell & Accessibility project tracks both repositories. The seven decomposed tasks are below the XL promotion threshold; no new project or duplicate issue was created.
- DorkOS worktree: `/Users/doriancollier/.dork/workspaces/dorkos/codex-blintz-polish`, branch `codex/blintz-polish`, initial pinned base `786a3df6637cbdcfba23992e35747e39b7bd49fc`; final integration base `0d5d7eb1e313fe1782c5108a445a7d1bf3a34c27` (0.75).
- Blintz worktree: `/Users/doriancollier/.dork/workspaces/blintz/codex-blintz-polish`, branch `codex/blintz-polish`, pinned base `dc475053423ec4501f7471a30d9e2a5eb4c96063`.
- Canonical tasks: `03-tasks.json`; local runtime trail: `.dork/flow/flow-state.json`, `execution.log.jsonl`, `flow-history.tsv` in the DorkOS worktree.
- npm publishing succeeded. Use the public 0.5.0 registry dependency in DorkOS; the matching GitHub tarball and visual archive provide durable release evidence. No fallback Git dependency is needed.
