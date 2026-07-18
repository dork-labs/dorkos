---
title: 'World-Class OG, SEO & AI-Agent Consumability for dorkos.ai — Audit + Frontier Research'
date: 2026-07-17
type: research
status: active
tags: [og-images, seo, aeo, geo, llms-txt, ai-agents, content-negotiation, next-js, fumadocs]
supersedes: 20260228_og_seo_ai_readability_overhaul.md
---

# World-Class OG, SEO & AI-Agent Consumability — Audit + Frontier Research

**Scope**: apps/site (Next.js 16 + Fumadocs 16 on Vercel, dorkos.ai). Four parallel investigations: (1) full local + live audit of every route's metadata/OG/JSON-LD/agent surfaces, (2) OG and link-sharing state of the art, (3) frontier technical SEO / AEO / GEO, (4) AI-agent consumability frontier. Claims marked "verified live" were confirmed with curl against production on 2026-07-17.

The February baseline report (20260228) has been fully implemented and exceeded: dynamic llms.txt + llms-full.txt, per-page docs markdown (`.mdx` rewrite), SoftwareApplication/WebSite/BlogPosting/BreadcrumbList JSON-LD, AI-crawler-aware robots.ts, favicon/icon.svg, marketplace + feature OG images, copy-page-as-markdown and open-in-ChatGPT/Claude/Cursor buttons. This report is the frontier follow-up.

---

## Where we already lead

- **Three-tier markdown stack** (llms.txt index → llms-full.txt dump → per-page `/docs/*.mdx`) matches the convention Cloudflare and Fumadocs converged on. Verified live: `/docs/getting-started/quickstart.mdx` serves real `text/markdown`.
- **JSON-LD survives streaming metadata.** Verified live with GPTBot UA: 2 `application/ld+json` blocks in raw HTML on home and blog posts. Non-JS AI crawlers (GPTBot, ClaudeBot, PerplexityBot: none execute JS) see our structured data.
- **robots.ts posture is right** for a tool that wants citations: explicit allows for GPTBot/ClaudeBot/PerplexityBot, blocks CCBot/Bytespider.
- **install.sh at a canonical URL + `/install` UA content negotiation** is the strongest "agent auto-detects how to install X" pattern there is; most sites don't have it.
- **Copy-for-AI UX** (`src/components/ai/page-actions.tsx`) is structurally Mintlify-class already; gap is breadth (no Perplexity, no Claude Desktop deep link), not architecture.

---

## P0 — Live bugs (fix now)

### 1. Blog posts ship with NO og:image (verified live)

`blog/[slug]/page.tsx` defines an `openGraph` object without `images`, which detaches the root file-based `opengraph-image` (Next.js shallow-merges; file convention only auto-attaches when the route doesn't override `openGraph`). `curl https://dorkos.ai/blog/dorkos-0-50-0` returns og:title/description/url but **no og:image at all**. Every blog share on Slack/Discord/LinkedIn/X renders without a preview card. Bluesky collapses to a bare link (no fallback thumbnail).
Fix: dedicated `blog/[slug]/opengraph-image.tsx` (see P1 template plan); interim fix is `images: ['/opengraph-image']`.

### 2. Sitemap lastModified is fabricated everywhere

Every `sitemap.ts` entry uses `lastModified: new Date()` (build time), so every URL reports "modified today" on every deploy, permanently. Google's trust model for lastmod is binary; Gary Illyes (2026-07-16): sites with unreliable lastmod are "probably better off without the lastmods". Ours is the worst version: false freshness on all URLs.
Fix: blog posts use `page.data.date`; docs use git last-commit date (build script) or frontmatter; omit lastModified where no real signal exists. Also: `priority`/`changeFrequency` are ignored by Google, keep as documentation only, don't tune.

### 3. Twitter cards are generic on every non-home page (verified live)

No route sets a `twitter` metadata block, so `twitter:title`/`twitter:description` fall back to the root default sitewide ("DorkOS - Mission control…" on blog posts, marketplace, features, docs). And on home, OG description (marketing layout long copy) diverges from Twitter description (short siteConfig copy).
Fix: derive twitter block from openGraph per route (helper in one place), and reconcile the home copy divergence deliberately.

### 4. WebSite JSON-LD comment claims a SearchAction that isn't there

`(marketing)/layout.tsx:47` comment says "WebSite with SearchAction (helps with sitelinks search box)"; the object has no `potentialAction`. Correct outcome, wrong comment: Google deprecated the sitelinks searchbox 2024-11-21. Fix the comment; do NOT add SearchAction.

---

## P1 — High impact

### 5. Per-content-type OG images (the biggest visible gap vs best-in-class)

Every best-in-class dev tool (Vercel, GitHub repo cards, Linear, Stripe, Tailwind docs) generates unique per-URL images. Template plan:

- **Blog** (`blog/[slug]/opengraph-image.tsx`): eyebrow "DorkOS Blog", dominant title (48-64px, 700-900px max width), date + reading time as small chips. Fixes P0 #1 properly.
- **Release posts / changelog**: **version number as the dominant visual element** (the single most differentiating pattern found; think GitHub release cards), one-line headline change beneath.
- **Docs** (`docs/[[...slug]]/opengraph-image.tsx`): breadcrumb/section eyebrow ("Docs / Getting Started"), page title dominant. Orients a zero-context recipient.
- **Install**: platform badges (macOS / Windows-alpha / CLI). Respect the demo-claim gate: image must not overstate Windows maturity.
- **Cross-cutting fixes**: load the real brand font (bundle TTF locally, Node runtime + `readFile`, not per-request Google Fonts fetch; Slack's unfurl timeout is tight). Feature OG route: set `runtime = 'edge'` consistently or move all to node, and make `alt` per-feature (currently generic 'DorkOS Feature').
- **Genre notes** from the competitive scan: one accent color used sparingly, wordmark small and corner-anchored, title always dominant, metadata as small chips. Our cream + orange/green identity is a differentiator in a sea of dark-background dev tools; keep it consistent across all templates.

### 6. Markdown content negotiation on canonical URLs + `.md` alias (verified gaps)

Verified live: `Accept: text/markdown` on `/docs/getting-started/quickstart` returns HTML; `.md` suffix returns 404 (only our nonstandard `.mdx` works). Agents that just GET the URL they were given (a citation, a pasted link) get full HTML; agents guessing the industry-standard `.md` suffix (Cloudflare, Mintlify convention) get a 404.
Fix is small because we already built the hard part (`llms.mdx` route + `getLLMText`):

- Add `Accept: text/markdown` negotiation in `src/proxy.ts` using `fumadocs-core/negotiation` (`isMarkdownPreferred` + `rewritePath`) targeting the existing `llms.mdx` route. This is Fumadocs' first-party pattern; Vercel and Cloudflare both ship it (Vercel reports ~99% payload reduction).
- Add a `/docs/:path*.md` rewrite alongside the `.mdx` one.
- Advertise it: `Link: <...page.md>; rel="alternate"; type="text/markdown"` header on docs HTML.
- SEO discipline: markdown responses are alternates of the canonical HTML, not indexable duplicates (noindex header on the .md route, canonical points at HTML).
- Optional polish: `x-markdown-tokens`/`x-original-tokens` headers (Cloudflare pattern), and a `sitemap.md` markdown link list (Vercel pattern; llms.txt route already computes the data).

### 7. Organization JSON-LD with sameAs + logo (missing entirely)

The actual knowledge-panel and entity-disambiguation lever. Emit once in root layout: Organization with `sameAs` [GitHub, npm, X, LinkedIn], `logo` ≥112×112 crawlable. Consolidates dorkos.ai + repo + npm package as one entity for Google and AI engines. Add `SoftwareSourceCode` (linked via `isSourceCodeOf`) for the open-source identity: cheap, targets the Priya persona's "is this really open source" question.

### 8. Bing Webmaster Tools + IndexNow + GSC (ops, not code)

Bing's index feeds ChatGPT Search and Copilot, making Bing more load-bearing for AI visibility than classic rank suggests. Google does not support IndexNow; Bing/Yandex do (Bing: 22% of clicked SERP URLs originated from IndexNow submissions).

- Verify dorkos.ai in both consoles via **DNS TXT** (domain property, survives refactors, covers future subdomains).
- Submit sitemap.xml to both.
- IndexNow: host key file at domain root, ping `api.indexnow.org` for changed URLs on deploy (small CI step or route; no native Vercel integration exists).
- One-time check: confirm Vercel Attack Challenge Mode is off/log-only and the AI-bots managed ruleset isn't in deny mode (silent CAPTCHA-blocking of ClaudeBot/GPTBot is invisible until citations drop).

### 9. Docs pages: canonical + JSON-LD + specific social copy

Docs currently have no `alternates.canonical`, no JSON-LD, and generic OG/Twitter titles (verified live on quickstart). Add canonical, `TechArticle` + `BreadcrumbList`, and per-page OG (see #5). Docs are our most-cited surface for AI answers; this is where entity/article markup pays.

### 10. Feed discovery + formats

RSS autodiscovery `<link rel="alternate" type="application/rss+xml">` exists only on `/blog`; most readers autodiscover from article pages. Promote to root layout `alternates.types`. Optional: JSON Feed variant is cheap from the same data.

---

## P2 — Medium impact, cheap

11. **Discord theme-color accent**: Discord colors the embed's left bar from `<meta name="theme-color">`. We currently emit two media-scoped values (#FFFCF7 light / #09090b dark) from `viewport.themeColor`; Discord's handling of media-scoped variants is inconsistent. Test whether a single brand-orange (#E86C3A) non-scoped tag wins on marketing pages without wrecking Safari toolbar tinting (theme-color also tints mobile browser chrome; that's why it's cream today). Decide with a real Discord test.
12. **`twitter:label1/data1`** on blog posts ("Reading time · N minutes", "Version · 0.50.0"): read by both X and Slack, two meta tags via `other`.
13. **`article:published_time` / `article:modified_time`** on blog posts (ISO 8601): freshness signal for Meta crawlers and AI comprehension.
14. **Changelog as first-class surface**: an indexable per-version page (from the compiled CHANGELOG) with real per-entry lastmod + `softwareVersion` in JSON-LD, plus a **JSON changelog feed** (`/changelog.json`, `{version, date, entries[]}`) so agents answer "what's new in DorkOS" without parsing prose. Freshness matters: content updated within 60 days is ~1.9x more likely to be AI-cited. Do NOT build a bespoke `/api/version`; npm registry + GitHub Releases are already canonical, link them from llms.txt instead.
15. **Context7 listing**: add `context7.json` at repo root (or request inclusion). Near-zero cost; Context7 is a default docs source in many agent setups (including ours).
16. **robots.ts explicit tokens**: add `OAI-SearchBot`, `ChatGPT-User`, `Claude-User`, `Claude-SearchBot`, `claude-code` to the explicit allow list (currently correct only by wildcard fallthrough; Anthropic docs confirm each token is independent). Make an explicit decision on `meta-externalagent`.
17. **Web manifest + apple-icon**: still missing (site.webmanifest, apple-icon 180×180, `metadata.manifest`). Degraded add-to-homescreen/iOS behavior today.
18. **OG URL cache versioning**: platform caches (LinkedIn ~7d, WhatsApp days-weeks) only refresh on a NEW URL. When an OG template or title changes, bake a short content hash/`?v=` into the og:image URL.
19. **Legal/public pages consistency**: `/security`, `/privacy`, `/terms`, `/cookies`, `/telemetry` have no canonical and no openGraph block (unlike `/pricing` in the same group). Mechanical fix.
20. **htmlLimitedBots belt-and-suspenders**: JSON-LD is verified fine, but extending `htmlLimitedBots` in next.config.ts with `GPTBot|ClaudeBot|Claude-SearchBot|PerplexityBot|OAI-SearchBot|ChatGPT-User|Meta-ExternalAgent` forces fully-blocking metadata for those UAs, removing a whole class of future streaming regressions.
21. **ViewOptions breadth**: add Perplexity and a Claude Desktop (`claude://claude.ai/new?q=`) deep link (official scheme, ~14k char limit) beside the existing web links.

---

## P3 — Bigger bets and content strategy

22. **Read-only docs MCP server** (search + get-page wrapping the existing search route + `getLLMText`). Mintlify auto-ships this for every customer; Stripe and Cloudflare validate the pattern. Our audience (coding-agent operators) is the best-fit audience in existence. Scope read-only/no-auth; per the demo-claim gate, don't claim it works until verified with real client connections. Add `.well-known/mcp.json` discovery only once it ships.
23. **AEO content structure** (stronger citation lever than any markup, per the 54-study meta-analysis): answer-first paragraphs (40-60 word self-contained chunks), tables for comparisons (81% vs 23% extraction rate vs prose), definitions-first pages for DorkOS-coined terms. Concretely: a glossary (Mesh, Relay, Pulse, Harness Sync: zero competition, we own the definitions) and comparison pages (DorkOS vs raw Claude Code CLI, runtime-specific pages), each with an inbound link from a high-traffic page.
24. **Author identity / E-E-A-T**: real bylines with `Person` schema + `sameAs` (GitHub/X) and a lightweight authors page. Don't foreground raw GitHub star counts (6M fake stars study made them a discounted signal); foreground release cadence and responsiveness.
25. **Per-subsystem llms.txt** (`/docs/pulse/llms.txt` style, Cloudflare's pattern) when the docs tree grows enough.
26. **fediverse:creator** for Mastodon bylines: test first (open Mastodon bug can suppress og:description).

## Explicitly NOT worth doing (evidence-based)

- **More llms.txt investment**: two large-N studies (300k and 38k domains) found no measurable citation effect; general AI crawlers rarely fetch it. Keep ours (real value for Cursor/Claude Code-class tools), invest nothing further.
- **oEmbed endpoint**: consumers skew media-embed providers; Slack/Discord/Notion bookmarks all fall back to OG.
- **FAQ/HowTo rich-result hopes**: Google removed FAQ rich results May 2026; HowTo dead since 2023. FAQPage markup only where genuine FAQs exist, for AI parsing.
- **SearchAction, image sitemaps, sitemap splitting, priority/changefreq tuning**: dead or ignored.
- **ai.txt / agent-manifest.txt**: pre-standardization churn; wait.
- **x402/pay-per-crawl**: opposite of our goal. **WebMCP**: real but in Chrome origin trial, no transactional UI here; revisit in 6-12 months. **A2A agent cards**: right standard, wrong surface (belongs to the product's Mesh work, not the marketing site). **ai-plugin.json**: dead.

---

## QA workflow for OG changes

Polypane social previews (11 platforms at once) + LinkedIn Post Inspector + Meta Sharing Debugger (both official, both force-refresh caches). The X Card Validator is effectively retired; don't build process around it. Platform cache notes: Slack ~30 min (reads only first 32KB of HTML, drops images >1MB silently), LinkedIn ~7 days, WhatsApp on-device with no clear tool, iMessage bakes the preview in at send time, Bluesky/Mastodon read plain OG (1MB image cap on Bluesky).

## Suggested execution grouping

1. **PR 1 (bugs)**: blog og:image via new blog OG route, twitter block derivation, sitemap real lastmod, WebSite comment, legal-page canonicals. (P0 + #19)
2. **PR 2 (OG system)**: shared OG template components + brand font, docs/release/install templates, alt/runtime fixes, theme-color test, labels/article times, cache versioning. (#5, #11, #12, #13, #18)
3. **PR 3 (agent readability)**: proxy content negotiation + .md alias + Link headers, sitemap.md, robots explicit tokens, ViewOptions breadth, Context7 file. (#6, #15, #16, #21)
4. **PR 4 (entity + docs SEO)**: Organization/SoftwareSourceCode JSON-LD, docs canonical + TechArticle + breadcrumbs, feed autodiscovery, manifest/apple-icon, htmlLimitedBots. (#7, #9, #10, #17, #20)
5. **Ops session (no code)**: GSC + Bing DNS verification, sitemap submissions, IndexNow key + deploy ping, Vercel bot-management check. (#8)
6. **Later**: changelog surface + JSON feed, docs MCP, glossary/comparison content, authors. (#14, #22, #23, #24)

## Key sources

Google Search Central (Organization schema, sitelinks searchbox deprecation), Illyes on lastmod (2026-07-16), Next.js docs (htmlLimitedBots, ImageResponse, opengraph-image), vercel.com/blog/making-agent-friendly-pages-with-content-negotiation, developers.cloudflare.com/docs-for-agents, fumadocs.dev/docs/integrations/llms, GitHub engineering blog (OG framework, 2M images/day), Search Engine Journal (llms.txt 300k-domain null result), Trakkr (38k-domain replication), Machine Relations / Digital Applied (citation-factor meta-analysis), Anthropic crawler docs (ClaudeBot/Claude-User/Claude-SearchBot independence), Mintlify contextual-menu docs, Context7 library-owner docs, Discord theme-color support thread, Slack api.slack.com/robots. Full per-claim links live in the four agent reports in the session transcript.
