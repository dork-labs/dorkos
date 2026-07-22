# Canvas File Viewing Overhaul — Implementation Report

- **Id**: 260722-171944 · **Tracker**: DOR-420 · **Completed**: 2026-07-22
- **Shipped in**: blintz `v0.4.0` (npm), DorkOS PR [#417](https://github.com/dork-labs/dorkos/pull/417), PR [#415](https://github.com/dork-labs/dorkos/pull/415)

## What shipped

| Decision                     | Where it landed                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 reactive `editable`       | blintz 0.4.0 (`useBlintzEditor` syncs `editableRef` + `view.setProps` refresh; block-edit always registered with runtime `view.editable` guards). DorkOS consumes it directly; `CanvasMarkdownContent`'s remount-key workaround removed (#417).                                             |
| D2 theme correctness         | blintz 0.4.0 paints `.milkdown` root from crepe tokens and honors explicit `.light`/`[data-theme=light]` over OS dark. DorkOS forwards `data-theme` from a shared theme store (#417).                                                                                                       |
| D3 per-tab error containment | `CanvasErrorBoundary` inside `CanvasBody`, keyed by document id; Retry for ordinary errors, Reload-app-only for cached stale-chunk rejections (#417).                                                                                                                                       |
| D4 WebGL guard               | `Model3dViewer` catches renderer-construction failure → in-tab message; keyed by `url:format` so one failure doesn't poison the next model (#417).                                                                                                                                          |
| D5 file-type matrix          | `audio`/`video` content types + viewers, 3MF/PLY/FBX/DAE loaders, raw-route MIME additions + single-range HTTP Range (206/416), OpenAPI + agent contracts synced (#415).                                                                                                                    |
| Beyond spec                  | Theme state lifted into a shared Zustand store: live theme switches now propagate to every mounted consumer, including the agent-facing `control_ui set_theme` path (review finding on #417); resolved-theme collapse bug (`system`+OS-dark → light) fixed for CodeMirror and diff viewers. |

## Verification evidence (2026-07-22)

- Playwright sweep against the production build (`NODE_ENV=production`, fresh client dist): 19/19 in-browser checks after cache-artifact retest — code files in CodeMirror with intact tab strip; markdown pencil → `contenteditable=true` → typed text → autosave `PUT 200` → bytes on disk; theme correct in both mismatch directions (`#fdfcff` light tokens + painted root under OS-dark/app-light; `#1b1c1d` under OS-light/app-dark); STL/PLY/3MF render WebGL canvases; MP3 → `<audio>`, MP4 → `<video>`; ZIP → graceful message, no boundary trip; 8 canvas tabs intact end-to-end.
- Server: raw route returns `206`/`416`/correct MIME (`model/3mf`, `audio/mpeg`) and still `415`s unlisted extensions — curl-verified.
- Suites: DorkOS `pnpm verify` 13/13 (5,895+ client tests); blintz 27/27; both PRs' pre-push full-suite gates green; both reviewed per `REVIEW.md` (independent reviewer) **and** by the GitHub automated review (its one 🔴 finding fixed + re-review clean; its 🟡 nit fixed).

## Notes

- No ADRs extracted: all decisions are implementation-scoped to the canvas feature and the blintz package; the spec + PR bodies are the durable record. The one architectural nudge (theme in a shared store) follows the established app-store pattern rather than introducing a new one.
- Known dev-environment gotcha discovered en route: a long-running vite dev server keeps optimized deps **in memory** — after a dependency version bump, restart vite; deleting `node_modules/.vite` does nothing while it runs. (Recorded in agent memory.)
- Deferred: re-layering blintz's bundled vendor CSS (`@milkdown/theme-nord` universal-selector preflight) — tracked as a blintz follow-up; DorkOS contains it via `@import … layer(blintz)`.
