---
slug: agent-consumable-docs
id: 260717-132951
created: 2026-07-17
status: specified
linearIssue: DOR-165
---

# Agent-consumable docs: raw-markdown routes, llms-full.txt, AI page actions (and owns the fumadocs 16.10 / openapi 11 upgrade)

**Status:** Draft (frozen for DECOMPOSE)
**Author:** Backus (SPECIFY stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-165 · type task→feature · size 5 · Medium

## Overview

DorkOS docs should be as easy for an AI agent to read as for a human. Today the
docs render as HTML at `dorkos.ai/docs/*`, and one hand-built `llms.txt` gives an
index. This spec adds the machine-readable layer Priya and Kai want: a
**raw-markdown route** for every page (`/docs/<slug>.mdx`), a build-time
**`llms-full.txt`** that dumps the whole hand-authored corpus as one clean
markdown blob, and **page actions** above each doc ("Copy Markdown", "Open in
Claude", "View as Markdown", "Open in GitHub"). Priya pulls any page into Claude
as clean markdown; Kai's agents ingest the corpus in one fetch.

The ticket bundles this value with a **fumadocs upgrade** (core+ui 16.7→16.10,
openapi 10→11) because an earlier deps PR tried the core bump, hit the
openapi-11 peer-dependency wall, and reverted both. The upgrade and the AI
features are **technically independent**: the three AI-consumption features
already work at the currently-installed versions (verified against
`node_modules`, not the ticket — see Background). So this is **one spec, two
sequenced phases**:

- **Phase A — AI consumption (no version bump).** Ships the entire user-facing
  value on the current fumadocs (core/ui 16.7.16, openapi 10.6.8, mdx 14.3.0).
  Additive: one config flag, one helper, two new routes, one scaffolded UI
  component, one page insertion. Near-zero risk to existing pages.
- **Phase B — fumadocs upgrade (isolated infrastructure).** The welded
  core/ui 16.10 + openapi 11 bump and the `APIPage` client-component migration
  that the openapi 10→11 major forces. Self-contained, with an objective gate:
  site build green (including `/docs/api/*` prerender) + `/docs/api` renders +
  `openapi-fresh` CI green.

Phase B depends on Phase A **only for sequencing** — A ships value first so the
migration that already reverted once cannot hold the value hostage. Phase B's
**first** execute step reproduces the real prerender failure on a throwaway
install before applying the fix (Open Question O1), and Phase B's done-ness is
defined by its **gate**, not by the fix hypothesis — if the reproduced error
differs from the leading hypothesis (Decision D6), Phase B adapts within that
gate.

## Background / Problem Statement

Verified against the codebase and installed packages (2026-07-17):

- **The three AI features already work at the installed versions — no 16.10
  needed.** Confirmed against `node_modules`, not the ticket:
  - `includeProcessedMarkdown` exists in mdx 14.3.0 under
    `DocCollection.postprocess` (`fumadocs-mdx/dist/core-C9TGjTWd.d.ts:76`,
    `PostprocessOptions.includeProcessedMarkdown?: boolean | LLMsOptions`).
  - `page.data.getText('raw' | 'processed')` exists on page data now
    (`fumadocs-mdx/dist/types-DRpz2Vq2.d.ts:46`; `'processed'` is "only available
    when `includeProcessedMarkdown` is enabled").
  - `MarkdownCopyButton({ markdownUrl })` and
    `ViewOptionsPopover({ markdownUrl, githubUrl })` ship in **ui 16.7.16** via
    the public `fumadocs-ui/layouts/shared/page-actions` subpath
    (`node_modules/fumadocs-ui/dist/layouts/shared/page-actions.d.ts`).
  - `InferPageType<typeof source>` is the loader's page-type helper at 16.7.16
    (`fumadocs-core/dist/source/index.d.ts:2` exports `InferPageType`); the
    newer `$inferPage` alias is not required.
- **`getLLMText` is not a fumadocs export** — it is a hand-written helper the
  fumadocs LLM-integration guide prescribes. It calls
  `page.data.getText('processed')` and prepends a title/URL header.
- **The existing `llms.txt` stays.** `apps/site/src/app/llms.txt/route.ts` is a
  hand-built index (`export const dynamic = 'force-static'`) assembling
  capabilities, features, doc links, blog, and the live marketplace registry.
  `llms-full.txt` is a **new sibling** that dumps the full prose corpus; the two
  serve different needs (index vs full corpus).
- **The two bumps are welded.** `fumadocs-openapi@11` peer-requires
  `fumadocs-core@^16.10` and `fumadocs-ui@^16.10` (confirmed from the v11
  changelog); openapi 10 peer-caps core below 16.10. You cannot move one without
  the other — which is exactly why the deps PR reverted both.
- **The prerender crux (leading hypothesis, D6).** openapi 11 makes `APIPage` a
  **client component** ("requires `api-page.tsx` to be a client component";
  "server should pass page props using `page.data.getOpenAPIPageProps()`").
  DorkOS's `apps/site/src/components/api-page.tsx` carries the opposite
  invariant — a load-bearing comment: _"This file must NOT have 'use client' —
  APIPage is an async Server Component ... that performs file I/O to load the
  spec."_ The 65 generated MDX pages pass the spec as a **file-path string**:
  `<APIPage document={"../../docs/api/openapi.json"} operations={[...]} />`
  (`docs/api/api/tasks/post.mdx:14`). A v11 client `APIPage` cannot read that
  relative filesystem path at prerender/hydration, so `/docs/api/*` fails to
  prerender under the current wiring. The revert commit is **not in local git**,
  so this is reconstructed from the v11 changelog + current wiring and must be
  confirmed by reproduction before the fix is committed (O1).

Verified current tree: `apps/site/package.json` — `fumadocs-core ^16.7.16`,
`fumadocs-ui ^16.7.16`, `fumadocs-openapi ~10.6.8`, `fumadocs-mdx ^14.3.0`,
`next 16.2.9`, `react 19.2.5`. Corpus: **121 MDX files** under `docs/` — **56
hand-authored** prose pages + **65 generated** API pages.

## Goals

- **Phase A**
  - Every doc page is fetchable as clean markdown at `/docs/<slug>.mdx`
    (`text/markdown`), built statically.
  - A build-time `/llms-full.txt` concatenates the **hand-authored** corpus
    (the 65 generated API pages filtered out, Decision D3) as one markdown blob.
  - Each doc page shows page actions above the body — Copy Markdown + a
    View-Options menu (View as Markdown, Open in GitHub, Open in Claude, and the
    other AI deep-links the scaffold ships) — wired to the raw route and the
    GitHub source (Open-in-GitHub per O2), described honestly (Decision D5).
  - Ships entirely on the installed fumadocs; no dependency bump.
- **Phase B**
  - core/ui bumped to 16.10 and openapi to 11 together; the site builds with
    `/docs/api/*` prerendering.
  - `/docs/api` renders the interactive API reference under the v11 client
    `APIPage`.
  - `docs/api/api/**` regenerated to the v11 `generateFiles` shape and committed
    so the `openapi-fresh` CI gate stays green.

## Non-Goals

- Anything outside `apps/site` docs — no server OpenAPI schema changes, no
  client, no CLI, no shared changes.
- Rewriting or replacing the hand-built `llms.txt` (Decision D4 — keep as-is;
  `llms-full.txt` is additive).
- New docs **content** — this is plumbing, not authoring.
- Other machine-readable surfaces (`sitemap.ts`, `robots.ts`, `blog/feed.xml`,
  OG images) — untouched.
- A fumadocs layout redesign — only the minimum UI to place the page actions
  above `DocsBody`.
- A **Claude Code / desktop deep link** for "Open in Claude" — the scaffold's
  button is a **claude.ai web** deep-link (Decision D5); no Claude Code URL
  scheme is introduced.
- Feeding the near-empty generated API pages into `llms-full.txt` (Decision D3).

## Technical Dependencies

- **Phase A — no new/bumped dependencies.** Uses installed
  `fumadocs-core 16.7.16`, `fumadocs-ui 16.7.16`, `fumadocs-mdx 14.3.0`,
  `next 16.2.9`, `react 19.2.5`. New APIs consumed (all verified present):
  `defineDocs({ docs: { postprocess } })`, `page.data.getText('processed')`,
  `InferPageType`, `source.getPages()`/`getPage()`/`generateParams()`, and the
  `fumadocs-ui/layouts/shared/page-actions` primitives.
- **Phase B — a welded version bump:**
  - `fumadocs-core ^16.7.16 → ^16.10` and `fumadocs-ui ^16.7.16 → ^16.10`.
  - `fumadocs-openapi ~10.6.8 → ^11` (peer-requires core/ui ^16.10).
  - `fumadocs-mdx 14.3.0` — re-check peer compatibility with core 16.10; bump
    only if the peer range demands it (EXECUTE resolves from the resolved
    lockfile, not assumed).
  - `next 16.2.9` / `react 19.2.5` — expected unchanged; confirm openapi 11
    imposes no newer peer during the reproduce step.
  - Docs: fumadocs LLM integration guide (`fumadocs.dev/docs/integrations/llms`)
    for Phase A; fumadocs-openapi v11 changelog / UI docs for Phase B.

## Detailed Design

### Phase A — AI consumption (current fumadocs, additive)

#### A.1 — Enable processed markdown (`apps/site/source.config.ts`)

`defineDocs` accepts `{ dir?, docs?: Omit<DocCollection,'dir'|'type'>, meta? }`
(`fumadocs-mdx/dist/core-C9TGjTWd.d.ts:153`). Keep `dir`; add the `docs`
override carrying `postprocess`:

```ts
export const docs = defineDocs({
  // Points to the root-level docs/ directory in the monorepo
  dir: '../../docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});
```

This makes fumadocs-mdx export the compiled markdown per page (`_markdown`),
unlocking `page.data.getText('processed')`. The `blogPosts` collection is
untouched. `postinstall` runs `fumadocs-mdx` (regenerates `.source`) so the flag
takes effect on the next build.

#### A.2 — The `getLLMText` helper (`apps/site/src/lib/get-llm-text.ts`, new)

The single serialization contract for both new routes. **Verbatim:**

```ts
import type { InferPageType } from 'fumadocs-core/source';
import { source } from '@/lib/source';
import { siteConfig } from '@/config/site';

/**
 * Serialize one docs page to clean markdown for AI consumption.
 *
 * Emits a stable header — the page title and its absolute canonical URL — then
 * the page's processed markdown body (frontmatter stripped, MDX compiled to
 * plain markdown). Used by the per-page raw route and by llms-full.txt so both
 * surfaces share one format.
 *
 * @param page - A docs page from the fumadocs source loader.
 */
export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const processed = await page.data.getText('processed');
  const url = `${siteConfig.url}${page.url}`;
  const header = page.data.description
    ? `# ${page.data.title}\nSource: ${url}\n\n${page.data.description}`
    : `# ${page.data.title}\nSource: ${url}`;
  return `${header}\n\n${processed}`;
}
```

**getLLMText contract (locked):**

- **Input:** one loader page (`InferPageType<typeof source>`).
- **Output shape, in order:** an H1 `# {title}`; a `Source: {absoluteUrl}` line
  (`${siteConfig.url}${page.url}`, e.g. `https://dorkos.ai/docs/guides/foo`);
  the frontmatter `description` as a paragraph **if present**; a blank line; then
  the **processed markdown body**.
- **Absolute URL** (not fumadocs' relative-`page.url` default) — matches the
  existing `llms.txt` convention (`${siteConfig.url}${page.url}`,
  `llms.txt/route.ts:70`) and gives an ingesting agent canonical, fetchable
  links. This also makes "Open in Claude" honest: claude.ai is handed the page
  URL and told to read it, and the raw route serves exactly this text.
- **Frontmatter is NOT serialized** — `getText('processed')` yields the compiled
  markdown body without frontmatter; `title`/`description`/`Source` are lifted
  into the header explicitly.
- **Headings** in the body are preserved verbatim from the processed markdown.

#### A.3 — Raw-markdown route (`apps/site/src/app/(docs)/docs/[[...slug]].mdx/route.ts`, new)

A **sibling** catch-all segment whose folder name carries the literal `.mdx`
suffix — distinct from the existing `[[...slug]]` page segment (a single segment
cannot hold both `page.tsx` and `route.ts`, so the `.mdx` sibling is required and
is the fumadocs-blessed placement). It matches `/docs/<...slug>.mdx`, so the
page-action button's `markdownUrl` is exactly `${page.url}.mdx`.

```ts
import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/source';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

/**
 * Serve a docs page as raw markdown at /docs/<slug>.mdx for AI consumption.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

/** Prerender one .mdx route per docs page. */
export function generateStaticParams() {
  return source.generateParams();
}
```

- **Caching/static semantics:** `export const dynamic = 'force-static'`
  (matching `llms.txt/route.ts:11`) + `generateStaticParams()` → one static
  `.mdx` file per page, emitted at build. Zero per-request cost.
- **Content type:** `text/markdown; charset=utf-8`.
- **EXECUTE verification note:** confirm at build that Next 16 resolves the
  `[[...slug]].mdx` folder to `/docs/<slug>.mdx` and prerenders it. If the
  build rejects the segment name, fall back to the fumadocs alt placement
  `app/(docs)/docs/[[...slug]].md/route.ts` or `app/llms.mdx/docs/[[...slug]]`
  and set `markdownUrl` to match — but the pinned target is `.mdx` producing
  `${page.url}.mdx` (research row 4, ideation §5.1).

#### A.4 — Full-corpus route (`apps/site/src/app/llms-full.txt/route.ts`, new)

Mirrors the existing `llms.txt` static shape; joins hand-authored pages through
`getLLMText`.

```ts
import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

/**
 * Build-time full-corpus dump: every hand-authored docs page as one markdown
 * blob. Generated OpenAPI operation pages are filtered out (they carry an
 * `_openapi` marker and no prose); the API surface stays represented by
 * docs/api/openapi.json and the /docs/api links in llms.txt.
 */
export async function GET() {
  const pages = source.getPages().filter((page) => !page.data._openapi);
  const parts = await Promise.all(pages.map(getLLMText));
  return new Response(parts.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
```

- **llms-full.txt format (locked):** each page rendered by `getLLMText`
  (H1 title + `Source:` URL + optional description + processed body), pages
  joined by a blank-line separator (`\n\n`). Served `text/plain; charset=utf-8`
  (matches `llms.txt/route.ts:198`; the corpus is a text dump, not a single
  rendered document).
- **D3 filter:** exclude pages carrying the `_openapi` frontmatter marker (the
  deterministic signal every generated operation page sets — see
  `docs/api/api/tasks/post.mdx:4`). Precise: drops exactly the 65 generated
  pages, keeps every hand-authored page including any hand-written `docs/api`
  overview. **Fallback** if the loader does not surface `_openapi` on
  `page.data`: the slug-prefix rule `!(page.slugs[0] === 'api' &&
page.slugs.length > 1)`, mirroring `llms.txt/route.ts:55`. EXECUTE picks the
  accessor that the loader actually exposes; the filter **intent** is locked.
- **Size/cost:** ~56 hand-authored pages ≈ ~0.7 MB ≈ ~175k tokens — one static
  file per build, zero per-request cost, grows with the corpus.

#### A.5 — Page-action components (`apps/site/src/components/ai/page-actions.tsx`, new)

Scaffold with `npx @fumadocs/cli add ai/page-actions` (writes local,
customizable **client** components into the project). The scaffold exports
`LLMCopyButton` and `ViewOptions`, wrapping the ui primitives
`MarkdownCopyButton({ markdownUrl })` and
`ViewOptionsPopover({ markdownUrl, githubUrl })` from
`fumadocs-ui/layouts/shared/page-actions` (present at ui 16.7.16). Keep the
scaffold output as-authored (local ownership is the point); it is a client
module (`'use client'`) that the server docs page renders with string props.
TSDoc the exports (Hard Rule 4) if the scaffold omits it.

The `ViewOptions` menu ships (from the fumadocs source): **Copy Markdown**
(client `fetch(markdownUrl)` → clipboard), **View as Markdown** (link to
`markdownUrl`), **Open in GitHub** (`githubUrl`), **Open in Claude**
(`claude.ai/new?q=…`), and additional deep-links (Open in ChatGPT, Scira,
Cursor). See User Experience for the honest framing (Decision D5).

#### A.6 — Insert page actions above the body (`apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx`)

The catch-all page (an async Server Component) renders the client page-action
row **after `<DocsDescription>` and before `<DocsBody>`**:

```tsx
const markdownUrl = `${page.url}.mdx`;
const githubUrl = `${siteConfig.github}/blob/main/docs/${page.path}`;
// ... inside <DocsPage>, before <DocsBody>:
{
  !page.data._openapi && (
    <div className="flex flex-row items-center gap-2 border-b pb-4">
      <LLMCopyButton markdownUrl={markdownUrl} />
      <ViewOptions markdownUrl={markdownUrl} githubUrl={githubUrl} />
    </div>
  );
}
```

- **`markdownUrl`** = `${page.url}.mdx` → the A.3 route.
- **`githubUrl` (O2 — wire it)** = `${siteConfig.github}/blob/main/docs/${page.path}`.
  `page.path` is the file path relative to the `docs/` content dir
  (`Page extends SharedFileInfo { path: string }`,
  `fumadocs-core/dist/index-gTnj-v3t.d.ts:280,286`); `siteConfig.github` is
  `https://github.com/dork-labs/dorkos` (`config/site.ts:13`). Use the plain
  canonical github URL (no UTM), matching `llms.txt`.
- **Sub-decision D-A1 (gate on prose):** render the row only when
  `!page.data._openapi` — the generated API pages have no prose to copy, so a
  "Copy Markdown" there would be a dead affordance (same rationale as D3). The
  raw `.mdx` route still serves those pages (harmless); only the buttons are
  hidden. Reuse the `_openapi` marker so A.4 and A.6 share one signal.
- Server → client boundary is clean: only strings (`markdownUrl`, `githubUrl`)
  cross into the client components.

### Phase B — fumadocs upgrade (isolated infrastructure)

Every DorkOS-side API touched by openapi 10→11, in migration order. **Phase B's
first execute step is B.0 (reproduce), not a code edit.**

#### B.0 — Reproduce the real failure first (O1)

On a **throwaway install** (bump the deps in a scratch worktree/branch, do not
commit), run `pnpm --filter @dorkos/site build` and capture the actual
`/docs/api/*` prerender error. Confirm (or correct) the D6 hypothesis before
touching `api-page.tsx`. This is cheaper and more reliable than hunting the
absent revert commit. **Adaptation boundary:** the migration's target design
below (client `APIPage` + `getOpenAPIPageProps` bridge) is the leading
hypothesis; Phase B is **done** when its gate is green (build + `/docs/api`
render + `openapi-fresh`), regardless of whether the exact fix matches D6. If
the reproduced root cause differs, adapt the fix within that gate and record the
correction as a resolved open question.

#### B.1 — Dependency bump (`apps/site/package.json`)

Bump `fumadocs-core` and `fumadocs-ui` to `^16.10`, `fumadocs-openapi` to `^11`,
in one change (the peers are welded). Re-check `fumadocs-mdx` against core 16.10
and bump only if required. Update the pnpm lockfile. Confirm `next`/`react`
peers are satisfied during B.0.

#### B.2 — Server OpenAPI instance (`apps/site/src/lib/openapi.ts`)

- `createOpenAPI({ input: ['../../docs/api/openapi.json'] })` **stays** — it is
  the server schema loader (v11 keeps server config here). `input` as a
  file-path array remains valid server input.
- `createAPIPage(openapi)` — in v11 this produces a **client** component and UI
  options (`mediaAdapters`, `shikiOptions`, `playground.enabled`) move here from
  the server. DorkOS passes **none** today, so the options object stays empty —
  but `createAPIPage` must now be invoked from a client module (B.3), so the
  `APIPage` factory call moves out of this server file into the client
  `api-page.tsx`. `lib/openapi.ts` keeps only the server `openapi` instance and
  (if v11 requires) exposes it to the server page for `getOpenAPIPageProps`.

#### B.3 — `APIPage` becomes a client component (`apps/site/src/components/api-page.tsx`)

Invert the current invariant. The file becomes a `'use client'` module that
creates and re-exports the v11 client `APIPage` (via `createAPIPage` from
`fumadocs-openapi/ui`). Delete the load-bearing "must NOT have 'use client'"
comment and replace it with a comment explaining the v11 client-component
requirement. The client `APIPage` renders from **serialized props**, never file
I/O.

#### B.4 — Server → client props bridge (`apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx`)

Under v11 the **server** supplies the OpenAPI page props (the v11 guidance:
"server should pass page props using `page.data.getOpenAPIPageProps()`", provided
by `openapiPlugin`). Reconcile with the current flow where the generated MDX
embeds `<APIPage document="…path…" operations={…} />` and receives `APIPage`
through `getMDXComponents({ APIPage })` (`page.tsx:47`):

- The catch-all server page resolves the bundled OpenAPI props for API pages
  (via `page.data.getOpenAPIPageProps()` or the exact v11 accessor confirmed in
  B.0) and passes them into the client `APIPage` so it no longer reads a
  filesystem path.
- The generated MDX’s `document` prop stops being a relative file path (B.6
  regenerates it to the v11 shape). The precise wiring — whether the document is
  bundled at generate-time into the MDX, or injected by the server page, or
  both — is **resolved in EXECUTE from the reproduced v11 behavior** (B.0). The
  **contract** is fixed: `/docs/api/*` prerenders and renders interactively with
  no runtime relative-path file read.

#### B.5 — Generator migration (`apps/site/scripts/generate-api-docs.ts`)

- v11 `generateFiles` input: the changelog notes "drop the whole-map factory
  `() => SchemaMap`; use a record instead" and "expects an OpenAPI server
  instance." DorkOS already passes `input: openapi` (the server instance) +
  `output` + `includeDescription: true`, which matches the "server instance"
  path — re-verify the exact v11 `Config` signature
  (`fumadocs-openapi/dist/generate-file.d.ts`) and update `input`/options if the
  field shapes changed.
- Keep the pre-generation prune (`fs.rmSync(generatedDir, …)`,
  `generate-api-docs.ts:37`) — it guards against orphan pages breaking
  prerender and is orthogonal to the version.
- The **emitted MDX shape will likely change** (the `<APIPage …>` `document`
  prop, frontmatter) — B.6.

#### B.6 — Regenerate `docs/api/api/**` (65 files) + hold `openapi-fresh`

Run `pnpm docs:export-api` then `pnpm --filter @dorkos/site generate:api-docs`,
commit the regenerated `docs/api/**`. The `openapi-fresh` gate
(`.github/workflows/docs-openapi-check.yml`) regenerates both artifacts and
fails on any diff, so the committed output **must** match the v11 generator
byte-for-byte. This gate is the objective "API docs still fresh + render" check.

#### B.7 — Verify the source plugin (`apps/site/src/lib/source.ts`)

`source.ts` already uses `openapiPlugin()` from `fumadocs-openapi/server` (the
v11-blessed plugin, not the removed `transformerOpenAPI`). Confirm the plugin
name/options are unchanged in v11 and that it supplies the page-data method B.4
relies on (`getOpenAPIPageProps`). Expected no-op; verify.

**Removed v11 surfaces DorkOS does not use** (no action, confirmed by grep):
`transformerOpenAPI`, `createCodeSample`, `generateTypeScriptSchema`, the
`ui/client` subpath, and the renames `allowedUrls→allowedOrigins`,
`groupStyle→folderStyle`, `disablePlayground→playground.enabled`.

## User Experience

- **Priya reads a doc in Claude.** Above the doc body sits a small, quiet action
  row: a "Copy Markdown" button and a "…" menu. She clicks Copy Markdown and the
  clean markdown lands on her clipboard; she pastes it into Claude. Or she opens
  the menu and picks "Open in Claude", which opens claude.ai in a new tab with a
  prompt already filled in asking Claude to read the page.
- **Kai's agents ingest the corpus.** An agent fetches `dorkos.ai/llms-full.txt`
  once and gets every hand-written doc as one markdown file, each page headed by
  its title and canonical link.
- **Any page, as markdown.** Appending `.mdx` to a docs URL
  (`/docs/guides/foo.mdx`) returns the raw markdown — the same text the buttons
  copy and that "Open in Claude" points Claude at.

**Copy (writing-for-humans; honest — Decision D5):**

- "Open in Claude" opens **claude.ai** (the web app) in a new tab with a prompt
  pre-filled to read this page's URL. It is **not** a Claude Code or desktop
  link, and it works because the raw `.mdx` route makes the page fetchable. Do
  not label or imply it opens Claude Code. Keep the scaffold's plain menu
  labels ("Open in Claude", "View as Markdown", "Open in GitHub"); do not add
  hype or claim an integration that isn't there.
- Page actions appear on hand-authored pages; the generated API reference pages
  (no prose to copy) don't show them (D-A1).

## API / data model changes

- **No DorkOS API or data-model change.** No Zod schema, no `conf` migration, no
  SQLite change, no server route. `docs/api/openapi.json` is regenerated by the
  existing `docs:export-api` from unchanged server schemas (Phase B refresh
  only; the OpenAPI _content_ does not change, only the generated MDX shape).
- **New public HTTP surfaces (site):** `GET /docs/<slug>.mdx` (`text/markdown`)
  and `GET /llms-full.txt` (`text/plain`), both static.

## Testing Strategy

Fumadocs routes are exercised primarily by the **build**, not vitest — the value
proof is "the static files exist and contain the right bytes."

- **Phase A — unit (vitest, `apps/site`):**
  - `get-llm-text.ts` — a purpose-built test with a fake page
    (`{ url, data: { title, description, getText } }`) asserts the header order
    (H1 title, `Source:` absolute URL, optional description) and that the
    processed body follows; asserts the URL is absolute
    (`siteConfig.url + page.url`); asserts description omitted when absent.
  - The `llms-full.txt` D3 filter — a small pure helper (or the filter
    predicate) tested to drop `_openapi`-marked pages and keep prose pages. If
    the predicate is inlined, extract it so it is unit-testable.
- **Phase A — build gate (the real acceptance):**
  `pnpm --filter @dorkos/site build` then assert: a `/docs/<slug>.mdx` exists and
  is `text/markdown` (e.g. `curl` a built page in `next start`, or inspect the
  static output); `/llms-full.txt` exists, is `text/plain`, contains a
  hand-authored page's title and **not** a generated API operation's `<APIPage>`
  line; a rendered docs page shows the Copy-Markdown + View-Options row above the
  body and not on an API page. Plus `pnpm --filter @dorkos/site typecheck` +
  `lint` green.
- **Phase B — build + CI gate (the only meaningful proof):**
  - `pnpm --filter @dorkos/site build` succeeds **including `/docs/api/*`
    prerender** (the exact failure B.0 reproduced now passes).
  - `/docs/api` and a sample operation page render the interactive `APIPage`
    (manual/browser check in `next start`).
  - `pnpm docs:export-api && pnpm --filter @dorkos/site generate:api-docs` is
    deterministic and the regenerated `docs/api/**` is committed →
    **`openapi-fresh` CI gate green** (the objective freshness contract). A dirty
    diff there is a hard fail.
  - `typecheck` + `lint` green.
- **No always-pass tests.** The build/CI gates are the substantive checks;
  vitest covers only the pure serialization + filter logic (where a bug is
  otherwise invisible until a corpus reader breaks).

## Performance Considerations

- Both new routes are `force-static` — generated once per build, **zero
  per-request cost**, exactly like the existing `llms.txt`.
- `llms-full.txt` scans ~56 pages at build (`Promise.all` over `getText`); build
  time impact is negligible and grows linearly with the corpus. Revisit only if
  the docs grow 5–10× (then consider streaming or on-demand).
- Phase A adds one static `.mdx` file per page (~121) to the build output —
  small text files, no runtime cost.
- Phase B changes no request-path performance; the client `APIPage` renders from
  bundled props (no per-request file I/O, an improvement over relative-path
  reads).

## Security Considerations

- The raw `.mdx` route and `llms-full.txt` expose **only** already-public docs
  content as markdown — no new data, no auth surface. They serve the same pages
  already public as HTML.
- No new external fetch at request time (both static). `llms.txt`'s marketplace
  fetch is unchanged and not shared with these routes.
- "Open in Claude/ChatGPT/etc." are outbound links the **user** clicks; they
  carry only the page's public URL. No credentials, no tokens.

## Documentation

- TSDoc on every new export (Hard Rule 4): `getLLMText`, both route handlers, the
  scaffolded page-action components (add if the scaffold omits it).
- Changelog fragment (`changelog/unreleased/`, timestamp-id + slug,
  `writing-for-humans`): "Read any doc as clean markdown, or pull the whole docs
  set into your agent in one fetch." Note the honest "Open in Claude" framing
  (opens claude.ai web).
- No `contributing/` guide change required (site-internal plumbing); optionally
  note the raw-markdown + llms-full.txt surfaces where the docs pipeline is
  described, if such a guide exists.
- Draft ADR (see Related ADRs) if the phase split / client-`APIPage` migration
  warrants a decision record at `/adr:from-spec`.

## Implementation Phases

DECOMPOSE shape — two phases, small tasks; Phase A ships independently.

- **Phase A — AI consumption (one PR, ~6 tasks):**
  1. `source.config.ts` postprocess flag (A.1).
  2. `lib/get-llm-text.ts` helper + unit test (A.2).
  3. Raw `.mdx` route + `generateStaticParams` (A.3).
  4. `llms-full.txt` route + D3 filter + filter unit test (A.4).
  5. Scaffold `components/ai/page-actions.tsx` (A.5).
  6. Insert the action row in `page.tsx` with `markdownUrl`/`githubUrl` + D-A1
     gate (A.6); build-gate verification; changelog.
- **Phase B — fumadocs upgrade (separate PR, gated, ~7 tasks):** 0. **Reproduce** the prerender error on a throwaway install (B.0) — first.
  1. Dependency bump + lockfile (B.1).
  2. `lib/openapi.ts` server/UI split (B.2).
  3. `api-page.tsx` → client component (B.3).
  4. `page.tsx` server→client props bridge (B.4).
  5. `generate-api-docs.ts` v11 signature (B.5).
  6. Regenerate + commit `docs/api/api/**`; hold `openapi-fresh` (B.6).
  7. Verify `source.ts` plugin (B.7); build + render + CI gate; changelog + ADR.

## Acceptance Criteria

**Phase A**

- [ ] `source.config.ts` sets `docs.postprocess.includeProcessedMarkdown: true`;
      `page.data.getText('processed')` returns compiled markdown.
- [ ] `GET /docs/<slug>.mdx` returns `text/markdown` — the page's title +
      absolute `Source:` URL header + processed body — for every docs page,
      built statically.
- [ ] `GET /llms-full.txt` returns `text/plain` joining the **hand-authored**
      corpus via `getLLMText`; the 65 generated API pages are excluded; a
      hand-authored page's title appears and no `<APIPage>` line does.
- [ ] Each hand-authored doc page shows Copy-Markdown + a View-Options menu above
      the body, wired to `${page.url}.mdx` and the page's GitHub source
      (`${siteConfig.github}/blob/main/docs/${page.path}`); generated API pages
      show no action row.
- [ ] "Open in Claude" is described/behaves as a claude.ai **web** deep-link (not
      Claude Code); copy carries no hype and claims no integration.
- [ ] `pnpm --filter @dorkos/site build` + `typecheck` + `lint` green; **no
      dependency bump** in this phase.

**Phase B**

- [ ] The real prerender failure was reproduced on a throwaway install and its
      root cause confirmed (or the D6 hypothesis corrected in writing) before the
      fix was committed.
- [ ] `fumadocs-core`/`fumadocs-ui` at `^16.10`, `fumadocs-openapi` at `^11`,
      lockfile updated; `next`/`react` peers satisfied.
- [ ] `pnpm --filter @dorkos/site build` succeeds **including `/docs/api/*`
      prerender**; `/docs/api` renders the interactive `APIPage` (client
      component, no runtime relative-path file read).
- [ ] `docs/api/api/**` regenerated to the v11 `generateFiles` shape and
      committed; `pnpm docs:export-api && generate:api-docs` is deterministic;
      **`openapi-fresh` CI gate green**.
- [ ] No use of removed v11 surfaces; `openapiPlugin()` still wired; `typecheck` + `lint` green.

## Open Questions

- ~~**O1 — exact prerender error.**~~ **(RESOLVED — B.0 reproduce-first.)** The
  revert commit is not in local git, so Phase B's first step reproduces the
  failure on a throwaway install (`bump 4 deps → next build`) to confirm the D6
  root cause before committing the fix. Answer: reproduce first; the migration's
  done-ness is its gate (build + render + `openapi-fresh`), and the fix adapts
  within that gate if the cause differs (adaptation boundary, B.0). Rationale:
  cheaper and more reliable than hunting the absent commit; keeps the spec honest
  about the reconstructed (not observed) root cause.
  - **(2026-07-17 — OBSERVED, Phase B EXECUTE task 2.0.)** Bumped core/ui `^16.10`
    (resolved 16.11.5), openapi `^11` (resolved 11.2.2), kept mdx 14.3.0.
    `pnpm install` was clean — openapi 11's new peers (`@scalar/api-client-react`,
    `json-schema-typed`, `@types/react`) are all **optional**; next 16.2.9 /
    react 19.2.5 satisfied; **mdx needed no bump** (14.3.0 peer-allows
    `fumadocs-core ^16.0.0`). Two real failures surfaced, both **before** the
    hypothesised prerender crash: 1. **Compile-time — confirms D6's direction, refines the mechanism.**
    `next build` compiled, then type-check failed: `src/lib/openapi.ts:2 —
'"fumadocs-openapi/ui"' has no exported member named 'createAPIPage'. Did
you mean 'createOpenAPIPage'?`. v11 renamed the factory
    `createAPIPage(server, options)` → `createOpenAPIPage(options)` (no server
    arg) and it now returns a **client** component (`'use client'`) that renders
    from serialized props — `payload.bundled` (a Document) or `document`
    (schema id) + `preloaded.docs` — never a file path. D6's core claim (client
    APIPage, file-path prop gone) is **CONFIRMED**; the first wall is just the
    compile-time rename, not the predicted runtime file read. Adopted wiring:
    the server calls `openapi.preloadOpenAPIPage(page)` (reads the `_openapi.preload`
    frontmatter the v11 generator now emits, bundles the schema **server-side**)
    and binds the resulting `preloaded` prop into the client APIPage through
    `getMDXComponents`; the v11 generator emits an MDX `Layout` that pulls
    `APIPage`/`OpenAPIPage` from `props.components`. No client-side filesystem read. 2. **Generator ↔ tsx incompatibility — NOT predicted by D6.**
    `generate:api-docs` (`tsx scripts/generate-api-docs.ts`) crashed at import:
    `SyntaxError: The requested module '../node_modules/.pnpm/xml-js@1.6.11/.../js2xml.js'
   does not provide an export named 'require_js2xml'`. openapi 11 bundles its
    CJS deps (xml-js) as ESM copies under its own `dist/node_modules/.pnpm/…`
    with rolldown interop exports. **Node's native ESM loader imports them
    correctly** (`node -e import('fumadocs-openapi')` → `generateFiles:
   function`); **tsx's esbuild loader mis-resolves the bundled-dependency
    `.pnpm` path** and fails. Fix (tasks 2.4/2.5): run the generator under
    `node` (native TS type-stripping) instead of `tsx`.
    Both fixes land inside the adaptation boundary — Phase B's done-ness is
    unchanged (site build incl. `/docs/api/*` prerender + `/docs/api` renders +
    `openapi-fresh` green).
- ~~**O2 — githubUrl in ViewOptions.**~~ **(RESOLVED — wire it, A.6.)**
  `githubUrl = ${siteConfig.github}/blob/main/docs/${page.path}`. Rationale:
  `siteConfig.github` already exists and `page.path` is on the page data;
  low-cost, and "Open in GitHub" is a genuinely useful affordance for Priya.
- ~~**D-A1 — page actions on generated API pages.**~~ **(RESOLVED — gate off.)**
  Render the action row only when `!page.data._openapi`; API operation pages have
  no prose to copy (same rationale as D3). The raw route still serves them.
- **Decided in EXECUTE, not open blockers:** the exact Next segment that yields
  `/docs/<slug>.mdx` (A.3 verification note), the precise v11 props-bridge wiring
  for `APIPage` (B.4, resolved from the B.0 reproduction), and whether
  `fumadocs-mdx` needs a peer bump (B.1). None is a floor-level blocker —
  direction is fully pinned.

## Related ADRs

- **Draft ADR (extract at `/adr:from-spec`):** _"Agent-consumable docs — split
  the AI-consumption features from the fumadocs 16.10 / openapi 11 upgrade into
  two sequenced phases; migrate `APIPage` to a client component under
  openapi 11."_ Captures the decoupling decision (D1/D2 — value ships without the
  risky bump), the client-component `APIPage` + `getOpenAPIPageProps` bridge
  (D6), and the reproduce-first / gate-defined adaptation boundary (O1).
- **No existing ADR constrains this** — `apps/site` docs plumbing has no prior
  decision record; the `openapi-fresh` gate is a CI convention, not an ADR.

## References

- Ideation: `specs/agent-consumable-docs/01-ideation.md` (decisions D1–D6, O1/O2,
  root-cause §4, research §5).
- Fumadocs LLM integration guide: `fumadocs.dev/docs/integrations/llms`
  (getLLMText, raw route, llms-full.txt, page-actions patterns).
- **Phase A code:**
  `apps/site/source.config.ts:4-7` (`defineDocs`);
  `apps/site/src/lib/source.ts:13-17` (`source` loader, `openapiPlugin`);
  `apps/site/src/app/llms.txt/route.ts:11,55,70,198` (static shape, api-filter
  precedent, absolute-URL precedent, content-type);
  `apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx:35-51` (catch-all page,
  `getMDXComponents({ APIPage })`);
  `apps/site/src/config/site.ts:7-14` (`siteConfig.url`, `.github`);
  `node_modules/fumadocs-mdx/dist/core-C9TGjTWd.d.ts:76,153`
  (`includeProcessedMarkdown`, `defineDocs` signature);
  `node_modules/fumadocs-mdx/dist/types-DRpz2Vq2.d.ts:46` (`getText`);
  `node_modules/fumadocs-ui/dist/layouts/shared/page-actions.d.ts`
  (`MarkdownCopyButton`, `ViewOptionsPopover`);
  `node_modules/fumadocs-core/dist/source/index.d.ts:2` (`InferPageType`, `llms`);
  `node_modules/fumadocs-core/dist/index-gTnj-v3t.d.ts:280,286,329,351`
  (`Page.path`, `getPages`, `generateParams`).
- **Phase B code:**
  `apps/site/src/lib/openapi.ts:9-18` (`createOpenAPI`, `createAPIPage`);
  `apps/site/src/components/api-page.tsx:1-10` (the "must NOT be client" comment
  to invert);
  `apps/site/scripts/generate-api-docs.ts:11,37,43-47` (`generateFiles`, prune,
  input/options);
  `docs/api/api/tasks/post.mdx:4,14` (`_openapi` marker, file-path `document`
  prop — 65 such files);
  `.github/workflows/docs-openapi-check.yml` (`openapi-fresh` gate);
  `node_modules/fumadocs-openapi/dist/server/create.d.ts` (v10 `createOpenAPI`),
  `.../ui/index.d.ts` (v10 `createAPIPage`),
  `.../ui/api-page.d.ts` (v10 `ApiPageProps.document: string`),
  `.../generate-file.d.ts:78` (`generateFiles` `Config`);
  fumadocs-openapi v11 changelog (peer `^16.10`, client `APIPage`,
  `getOpenAPIPageProps`, `generateFiles` input, removed/renamed surfaces).
- Tracker: DOR-165.
  </content>
  </invoke>
