---
slug: agent-consumable-docs
id: 260717-132951
created: 2026-07-17
status: ideation
linearIssue: DOR-165
---

# Agent-consumable docs: raw-markdown routes, llms-full.txt, AI page actions (+ owns the fumadocs 16.10 / openapi 11 upgrade)

**Slug:** agent-consumable-docs
**Author:** Knuth (IDEATE stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-165 · type task→feature · size 5 · Medium

---

## 1) Intent & Assumptions

- **Task brief (verbatim from DOR-165):** "Needs fumadocs-core/ui@16.10 +
  fumadocs-openapi@11.x. NOTE: the deps PR REVERTED the fumadocs 16.7→16.10 bump
  because fumadocs-openapi@10.6.8 is incompatible with core 16.10 (openapi 11.x
  peer-requires core ^16.10, a 10→11 major that broke the /docs/api prerender).
  So this task OWNS the fumadocs upgrade (core+ui 16.10 + openapi 11.x, validate
  the OpenAPI docs render) PLUS the AI page actions: source.config.ts
  includeProcessedMarkdown: true; new raw-markdown route
  (docs)/docs/[[...slug]].mdx/route.ts → getLLMText(page) as text/markdown; new
  llms-full.txt/route.ts mapping source.getPages() through getLLMText
  (complements the existing hand-built llms.txt); add <LLMCopyButton> +
  <ViewOptions> above DocsBody (npx @fumadocs/cli add ai/page-actions)."

- **Value (verbatim):** "docs become agent-consumable — Priya pulls any doc into
  Claude as clean markdown; Kai's agents ingest the corpus via llms-full.txt."

- **The one correction ideation carries forward:** the brief bundles two things
  that are **technically independent**. The three AI-consumption features
  (`includeProcessedMarkdown`, `getLLMText`/`getText('processed')`, the
  page-action components) **already exist and work at the currently-installed
  fumadocs versions (core/ui 16.7.16, mdx 14.3.0)** — verified against
  `node_modules`, not the ticket. They do **not** require the 16.10 bump. The
  16.10 + openapi-11 upgrade is a **separate, higher-risk infrastructure change**
  that only got attached here because a deps PR tried the core bump, hit the
  openapi peer-dep wall, and reverted. Recommendation (§5) is to ship them as two
  sequenced phases inside this one spec so the value isn't held hostage to the
  risky migration.

- **Assumptions:**
  - Scope is `apps/site` docs only (the marketing/docs Next.js 16 + Fumadocs
    app). No client, server, CLI, or shared changes.
  - The existing dynamic `llms.txt` route (`apps/site/src/app/llms.txt/route.ts`,
    a hand-built index of capabilities + features + doc links + marketplace) is
    **kept as-is**; `llms-full.txt` is a new, complementary sibling that dumps the
    full prose corpus, not a replacement.
  - "The deps PR" that reverted the 16.7→16.10 bump is **not present in the local
    git history** (searched `--all`); current tree is core/ui 16.7.16 +
    openapi 10.6.8. The exact prerender error is reconstructed from the
    fumadocs-openapi v11 changelog + code inspection, not from the revert commit
    (open question O1).
  - `pnpm` workspace; the site builds with `next build` and the `openapi-fresh`
    CI gate (`.github/workflows/docs-openapi-check.yml`) must stay green.

- **Out of scope:**
  - Anything outside `apps/site` docs (no server OpenAPI schema changes, no
    client, no CLI).
  - Rewriting the hand-built `llms.txt` route.
  - New docs content; this is plumbing, not authoring.
  - A general fumadocs "flux/notebook" layout redesign — only the minimum UI to
    place the two page-action components above `DocsBody`.

## 2) Pre-reading Log

- `apps/site/package.json`: current deps — `fumadocs-core ^16.7.16`,
  `fumadocs-ui ^16.7.16`, `fumadocs-openapi ~10.6.8`, `fumadocs-mdx ^14.3.0`,
  `next 16.2.9`, `react 19.2.5`. Confirms the tree is at 16.7/openapi-10 (the
  reverted state).
- `apps/site/source.config.ts`: `defineDocs({ dir: '../../docs' })` (root-level
  `docs/`), plus a `blogPosts` collection. This is where
  `postprocess.includeProcessedMarkdown: true` goes.
- `apps/site/src/lib/source.ts`: `loader({ baseUrl: '/docs', source:
docs.toFumadocsSource(), plugins: [openapiPlugin()] })`. `source.getPages()` /
  `source.getPage(slug)` are the loaders both new routes consume. Already uses
  `openapiPlugin()` (the v11-blessed API — not the removed `transformerOpenAPI`).
- `apps/site/src/lib/openapi.ts`: `createOpenAPI({ input:
['../../docs/api/openapi.json'] })` + `APIPage = createAPIPage(openapi)`. This
  is the surface the openapi 10→11 redesign rewrites (§5.B).
- `apps/site/src/components/api-page.tsx`: re-exports `APIPage` and carries a
  load-bearing comment — _"This file must NOT have 'use client' — APIPage is an
  async Server Component from fumadocs-openapi that performs file I/O to load the
  spec."_ This is the crux of the prerender break (§4).
- `apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx`: catch-all docs page.
  Renders `<DocsPage><DocsTitle/><DocsDescription/><DocsBody><Mdx
components={getMDXComponents({ APIPage })}/></DocsBody></DocsPage>`. The
  page-action components get inserted **above `<DocsBody>`**; `page.url` gives
  the `.mdx` markdown URL.
- `apps/site/scripts/generate-api-docs.ts`: `generateFiles({ input: openapi,
output, includeDescription: true })` after `fs.rmSync` of the generated
  `api/` subtree. This is the second openapi-11 migration point (`generateFiles`
  input/option changes, §5.B).
- `apps/site/src/app/llms.txt/route.ts`: the **existing hand-built** index —
  `force-static`, builds sections from `source.getPages()`, `subsystems`,
  `features`, live marketplace registry. Not touched; `llms-full.txt` mirrors its
  `force-static` shape.
- `docs/api/api/tasks/post.mdx` (generated sample): frontmatter `full: true`,
  `_openapi:` block, body is a single
  `<APIPage document={"../../docs/api/openapi.json"} operations={[{"path":"/api/tasks","method":"post"}]} />`.
  65 such files; the `document` prop is a **file-path string** resolved
  server-side today.
- `.github/workflows/docs-openapi-check.yml`: the `openapi-fresh` gate —
  regenerates `docs/api/openapi.json` (`pnpm docs:export-api`) + the MDX (`pnpm
--filter @dorkos/site generate:api-docs`), then fails if `git diff` on
  `docs/api/**` is dirty. Any change to the generated MDX shape under openapi 11
  must be regenerated and committed or this gate goes red.
- `node_modules/fumadocs-mdx/dist/types-DRpz2Vq2.d.ts` + `core-C9TGjTWd.d.ts`:
  **API-existence proof at the installed version** — `DocMethods.getText('raw' |
'processed')` and `PostprocessOptions.includeProcessedMarkdown` both present in
  mdx 14.3.0. `includeProcessedMarkdown` lives under `DocCollection.postprocess`.
- `node_modules/fumadocs-ui/dist/layouts/shared/page-actions.d.ts`: exports
  `MarkdownCopyButton({ markdownUrl })` and `ViewOptionsPopover({ markdownUrl,
githubUrl })` — present at **ui 16.7.16**, public via the `./layouts/shared`
  subpath. The `@fumadocs/cli add ai/page-actions` scaffold wraps these.
- `research/20260217_world_class_developer_docs.md`,
  `research/20260228_og_seo_ai_readability_overhaul.md`,
  `research/20260216_fumadocs_vercel_docs_site.md`: prior docs/AI-readability
  research — establish the "docs must be machine-readable" direction; none
  covers this exact upgrade, so this is net-new.

## 3) Codebase Map

- **Primary modules touched:**
  - `apps/site/source.config.ts` — add `docs: { postprocess: {
includeProcessedMarkdown: true } }` to `defineDocs`.
  - `apps/site/src/lib/get-llm-text.ts` — **new** hand-written helper (fumadocs
    ships no `getLLMText`; §5).
  - `apps/site/src/app/(docs)/docs/[[...slug]].mdx/route.ts` — **new** raw-markdown
    route (sibling catch-all with a literal `.mdx` segment).
  - `apps/site/src/app/llms-full.txt/route.ts` — **new** full-corpus route.
  - `apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx` — insert
    `<LLMCopyButton>` + `<ViewOptions>` above `<DocsBody>`.
  - `apps/site/src/components/ai/page-actions.tsx` (or similar) — **new**
    scaffolded client component from `@fumadocs/cli add ai/page-actions`.
  - **(Phase B only)** `apps/site/package.json`, `src/lib/openapi.ts`,
    `src/components/api-page.tsx`, `scripts/generate-api-docs.ts`, and the
    regenerated `docs/api/api/**` (65 files).
- **Shared dependencies:** the fumadocs source loaders (`source`, `blog`) in
  `src/lib/source.ts`; `page.url` / `page.slugs` / `page.data.getText`;
  `siteConfig` (`src/config/site.ts`, holds `github:
'https://github.com/dork-labs/dorkos'` for `ViewOptions` githubUrl).
- **Data flow (AI features):** MDX in `docs/` → fumadocs-mdx build (with
  `includeProcessedMarkdown`) exports `_markdown` per page → `source.getPage()` /
  `getPages()` expose `getText('processed')` → `getLLMText(page)` prepends a
  title/URL header → served as `text/markdown` (per-page route) or joined
  build-time into one `text/plain` blob (`llms-full.txt`).
- **Data flow (API docs, the upgrade surface):** Zod route schemas →
  `docs:export-api` → `docs/api/openapi.json` → `generate:api-docs`
  (`generateFiles`) → `docs/api/api/**` MDX (each an `<APIPage document=...
operations=.../>`) → catch-all page renders `APIPage = createAPIPage(openapi)` →
  interactive reference at `/docs/api/*`.
- **Feature flags/config:** none. `force-static` on both new routes (build-time,
  matching the existing `llms.txt`).
- **Potential blast radius:**
  - _AI features (Phase A):_ additive — two new routes, one config flag, one
    UI insertion. Near-zero risk to existing pages.
  - _Upgrade (Phase B):_ the whole `/docs/api/*` section + the site build +
    the `openapi-fresh` CI gate. This is where the earlier attempt broke.

## 4) Root-Cause Analysis — what broke on the 16.10 + openapi-11 attempt

_(Not a bug fix per se, but the ticket hinges on "the 10→11 major broke the
/docs/api prerender," so a root-cause pass is warranted. The revert commit is not
in local git, so this is reconstructed from the fumadocs-openapi v11 changelog +
inspection of DorkOS's current openapi wiring, and must be confirmed by
reproduction — O1.)_

- **The peer-dependency wall (confirmed):** `fumadocs-openapi@11.0.0`
  peer-requires `fumadocs-core@^16.10` and `fumadocs-ui@^16.10`. You cannot bump
  core/ui to 16.10 while staying on openapi 10.6.8 (openapi 10 peer-caps core at
  <16.10), and you cannot take openapi 11 without moving core/ui to 16.10. The
  two bumps are welded together — this is why the deps PR had to revert _both_.
- **Leading root-cause hypothesis for the prerender crash (high confidence):**
  openapi 11 makes **`APIPage` a client component** ("API page must be a client
  component"). DorkOS's `api-page.tsx` explicitly depends on the opposite —
  `APIPage` is an _async Server Component that does file I/O_ to load
  `docs/api/openapi.json`, and the 65 generated MDX pages pass the spec as a
  **file-path string** prop: `document={"../../docs/api/openapi.json"}`. A client
  component cannot read that path from a relative filesystem location at
  prerender/hydration time, so the `/docs/api/*` pages fail to prerender under v11
  with the current wiring. Fixing it means changing how the spec is provided to
  `APIPage` (import/bundle the parsed document, or the v11 server/client split)
  rather than passing a filesystem path.
- **Secondary migration breaks (from the v11 changelog, all confirmed as API
  removals/renames):**
  - `createOpenAPI()` redesigned: server config split from UI config. UI options
    (`mediaAdapters`, `shikiOptions`, `disablePlayground`→`playground.enabled`)
    move from `createOpenAPI` into `createAPIPage(openapi, {…})`. DorkOS's call is
    minimal (`createOpenAPI({ input })` + `createAPIPage(openapi)`), so this is a
    small edit — but `createAPIPage` now returns a client component.
  - `generateFiles()` input change: "drop the whole-map factory `() =>
SchemaMap`; use a record instead." DorkOS's `generate-api-docs.ts` passes
    `input: openapi` (the server instance) + `includeDescription: true`; the v11
    signature must be re-checked and the call updated. **The generated MDX output
    shape may also change** (component props / frontmatter), which flows into the
    `openapi-fresh` gate (below).
  - Removed: `transformerOpenAPI()` (DorkOS already uses `openapiPlugin()` ✓),
    `createCodeSample()`, `generateTypeScriptSchema()`, `ui/client` subpath,
    `allowedUrls`→`allowedOrigins`, `groupStyle`→`folderStyle`, a new
    `fuma-translate`-based translation API. DorkOS uses none of the removed
    surfaces except the two active call sites above.
- **The CI trap:** after the upgrade, `generate:api-docs` will (likely) emit
  differently-shaped MDX. The committed `docs/api/api/**` (65 files) must be
  regenerated and committed in the same PR, or `openapi-fresh`
  (`docs-openapi-check.yml`) fails on the diff. This gate is the objective
  "the OpenAPI docs still render + stay fresh" check.

## 5) Research

### 5.1 API-existence verification (verified against installed packages + fumadocs docs, not the ticket)

| Claim in ticket                                                             | Reality                                                                                                                                                                                                                                                                   | Source                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `includeProcessedMarkdown: true` in `source.config.ts`                      | **Exists now** (mdx 14.3.0), under `DocCollection.postprocess` — so `defineDocs({ docs: { postprocess: { includeProcessedMarkdown: true } } })`. No 16.10 needed.                                                                                                         | `core-C9TGjTWd.d.ts:76`, `:113`                                              |
| `getLLMText(page)`                                                          | **Not a fumadocs export.** Hand-written helper (`lib/get-llm-text.ts`) that calls `page.data.getText('processed')` and prepends a title/URL header. `getText('raw'\|'processed')` exists now on page data.                                                                | `types-DRpz2Vq2.d.ts:35-48`; fumadocs.dev/docs/headless/llms                 |
| `<LLMCopyButton>` + `<ViewOptions>` via `@fumadocs/cli add ai/page-actions` | Real. The CLI scaffolds **local, customizable** client components into the project. They wrap fumadocs-ui primitives `MarkdownCopyButton({ markdownUrl })` + `ViewOptionsPopover({ markdownUrl, githubUrl })`, which **already ship in ui 16.7.16** (`./layouts/shared`). | `page-actions.d.ts`; fumadocs source `packages/base-ui/.../page-actions.tsx` |
| Raw route `(docs)/docs/[[...slug]].mdx/route.ts`                            | Valid Next 16 pattern (literal `.mdx` in the segment → markdown URL is `${page.url}.mdx`). Fumadocs' own example uses `app/llms.mdx/docs/[[...slug]]/route.ts`; both work — keep the ticket's placement so the button's `markdownUrl` = page URL + `.mdx`.                | fumadocs.dev/docs/headless/llms                                              |
| `llms-full.txt/route.ts` mapping `source.getPages()` through `getLLMText`   | Valid; `force-static` build-time route joining pages with `\n\n`, `text/plain`.                                                                                                                                                                                           | existing `llms.txt/route.ts` as the pattern                                  |

**Net:** the three AI-consumption features require **zero version bump.** They
run on today's 16.7 / 14.3.0. Only the API-reference upgrade forces 16.10 +
openapi-11.

### 5.2 What "Open in Claude" actually is (honest description)

From the fumadocs `ViewOptionsPopover` / scaffolded `ViewOptions` source
(`packages/base-ui/src/layouts/shared/page-actions.tsx`), the menu items are:

- **Copy Markdown** (`LLMCopyButton`/`MarkdownCopyButton`): client-side
  `fetch(markdownUrl)` → copy the raw markdown to clipboard.
- **View as Markdown**: link to `markdownUrl` (our new `.mdx` route).
- **Open in GitHub**: link to `githubUrl` (source file on GitHub).
- **Open in ChatGPT**: `https://chatgpt.com/?prompt=<q>&hints=search`.
- **Open in Claude**: `https://claude.ai/new?q=<q>` — a **claude.ai web
  deep-link that opens a new chat pre-filled** with `q = "Read {url}, I want to
ask questions about it."` where `{url}` is the page's absolute URL. It is **not
  a Claude Code / desktop deep link**; it's the consumer web app, and it relies
  on Claude fetching the URL itself. Also ships "Open in Scira AI" and "Open in
  Cursor" (`cursor.com/link/prompt?text=<q>`) in the same menu.

Practical honesty note for copy/UX: "Open in Claude" hands claude.ai a prompt to
go _read the page URL_ — so its usefulness depends on the raw `.mdx` route being
public and fetchable. That makes the raw-markdown route a **prerequisite**, not
just a nicety, for the button to be worth anything.

### 5.3 llms-full.txt size / cost

- Corpus: **121 MDX files, ~733 KB** total (`docs/`). Split: **56 hand-authored**
  prose pages + **65 generated API pages**.
- The 65 generated API pages are each ~one `<APIPage .../>` line — `getText(
'processed')` yields little/no prose for them, so `llms-full.txt` is
  effectively the ~56 hand-authored pages (~0.7 MB of text).
- Estimate: **~700 KB ≈ ~175k tokens** for the full concatenation — comfortably
  inside a single modern context window (fits 200k; trivial for 1M).
- **Build-time, not runtime:** `force-static` route, generated once per build
  like the existing `llms.txt`. Zero per-request cost; grows with the docs corpus
  (revisit if docs 5–10×).
- **Decision needed (D3):** do we let the API pages contribute their empty/near-
  empty `getText('processed')` (noise), or filter them out of `llms-full.txt` and
  leave the API surface represented by `openapi.json` + the `/docs/api` links
  that `llms.txt` already carries? Recommend **filter API pages out** for v1.

### 5.4 Potential solutions / sequencing

1. **One big-bang PR (ticket's literal shape):** upgrade + AI features together.
   - _Pro:_ one unit, matches the ticket.
   - _Con:_ couples the low-risk value (AI features) to the high-risk migration
     (the thing that already got reverted once). If the openapi-11 prerender fix
     proves hard, the whole ticket stalls and Priya/Kai get nothing.
2. **Two sequenced phases inside one spec (recommended):**
   - **Phase A — AI-consumption (no version bump):** `includeProcessedMarkdown`,
     `get-llm-text.ts`, the `.mdx` route, `llms-full.txt`, page-action components
     above `DocsBody`. Ships the entire user-facing value on current 16.7. Small,
     additive, independently verifiable (routes return markdown; buttons work).
   - **Phase B — fumadocs upgrade (isolated infra):** core/ui 16.7→16.10 +
     openapi 10→11; migrate `lib/openapi.ts` + `api-page.tsx` (client-component
     spec loading) + `generate-api-docs.ts`; regenerate `docs/api/api/**`;
     validate build + `/docs/api` render + `openapi-fresh` green.
   - _Pro:_ value ships first and can't be blocked by the migration; Phase B is a
     self-contained, reviewable upgrade with a clear pass/fail gate.
   - _Con:_ two PRs instead of one (a feature, not a bug — smaller reviews).

**Recommendation:** Option 2. Keep it one spec / one Linear item (DOR-165) with
two phases so the ticket still "owns the upgrade," but land Phase A first.

### 5.5 Validation gate (for SPECIFY / VERIFY)

- **Phase A:** `curl /docs/<slug>.mdx` returns `text/markdown` of the processed
  page; `curl /llms-full.txt` returns the joined corpus; the docs page shows
  working Copy-Markdown + View-Options above the body; `pnpm --filter
@dorkos/site build` + typecheck + lint green.
- **Phase B:** `pnpm --filter @dorkos/site build` succeeds **including
  `/docs/api/*` prerender**; every operation page renders the interactive
  `APIPage`; `pnpm docs:export-api && pnpm --filter @dorkos/site generate:api-docs`
  is deterministic and the regenerated `docs/api/**` is committed →
  **`openapi-fresh` CI gate green**; typecheck + lint green.

## 6) Decisions

| #   | Decision                                         | Choice                                                                                                                                                           | Rationale                                                                                                                                                                                             |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Do the AI features actually need the 16.10 bump? | **No** — ship them on current 16.7                                                                                                                               | `includeProcessedMarkdown`, `getText('processed')`, and the page-action primitives all verified present in the installed packages. Decouples value from risk.                                         |
| D2  | Sequencing of upgrade vs AI features             | **Two phases in one spec; Phase A (AI) first, Phase B (upgrade) second**                                                                                         | Value can't be blocked by the migration that already got reverted once; Phase B is isolated with a clean pass/fail gate.                                                                              |
| D3  | `llms-full.txt` contents                         | **Hand-authored prose pages only; filter out the 65 generated API pages**                                                                                        | API pages yield no prose via `getText('processed')`; API surface is already covered by `openapi.json` + the `/docs/api` links in the existing `llms.txt`. Keeps the file signal-dense (~175k tokens). |
| D4  | Keep or replace the existing `llms.txt`          | **Keep as-is; add `llms-full.txt` alongside**                                                                                                                    | Per ticket ("complements the existing hand-built llms.txt"); the two serve different needs (index vs full corpus).                                                                                    |
| D5  | "Open in Claude" description                     | **Describe honestly as a claude.ai web deep-link** (`claude.ai/new?q=…`) that pre-fills a chat asking Claude to read the page URL — not a Claude Code deep link  | Honest-by-design; also surfaces that the raw `.mdx` route is a hard prerequisite for the button to be useful.                                                                                         |
| D6  | `APIPage` spec loading under openapi 11          | **Change how the spec reaches `APIPage`** (import/bundle the parsed document rather than passing a filesystem-path prop) — resolve concretely in SPECIFY/EXECUTE | v11 makes `APIPage` a client component; the current file-path `document` prop + server-side file I/O is the leading cause of the prerender break.                                                     |

---

## Recommended direction & next step

**Direction:** Proceed to SPECIFY as a **single spec with two sequenced phases**.
Phase A delivers all the agent-consumable value on the current fumadocs (no
version bump, additive, low risk). Phase B performs the isolated core/ui 16.10 +
openapi 11 upgrade with the `openapi-fresh` gate + `/docs/api` prerender as the
objective validation. This honors "the task owns the upgrade" while ensuring the
value ships even if the migration proves stubborn.

**Next step:** advance to SPECIFY (`/flow:specify`) to freeze: the `get-llm-text`
helper contract, the two route shapes, the `source.config.ts` diff, the
page-action placement, and — critically — the concrete openapi-11 `APIPage`
spec-loading fix (D6) and the `generate-api-docs.ts` migration, each with its
verification command.

## Open questions

- **O1 — exact prerender error:** the revert commit isn't in local git, so the
  precise error from the 16.10 + openapi-11 attempt is reconstructed, not
  observed. SPECIFY/EXECUTE should **reproduce on a throwaway branch** (bump the
  four fumadocs deps, run `next build`) to capture the real failure before
  committing to the D6 fix — cheaper and more reliable than hunting the deps PR.
- **O2 — `githubUrl` in `ViewOptions`:** wire a per-page GitHub source link
  (`github.com/dork-labs/dorkos/blob/main/docs/<path>` from `page.data` file
  info) for the "Open in GitHub" item, or omit it for v1? Low stakes; default to
  **wire it** since `siteConfig.github` already exists and the file path is on
  the page data.
