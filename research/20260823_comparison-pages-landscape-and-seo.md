---
date: 2026-08-23
type: competitive
status: current
topic: 2026 orchestrator/coding-agent landscape sweep beyond the named list, plus comparison-page SEO/GEO mechanics for the /compare programme
---

# Comparison pages: landscape sweep + SEO mechanics

**Purpose:** seed data for the `/compare` programme (see `specs/comparison-pages/`). Companion: `research/20260823_comparison-pages-competitor-verification.md` (the 11 named products). Verified 2026-08-23; this market churns monthly — re-verify before citing.

## Task A — products the named list missed

### Tier 1 (high search intent + close category overlap → build pairwise pages)

| Product                 | Maker                   | What it is                                                                                                                                                                                                                                                  | Traction / note                                                                                                                                                           |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot Agent HQ | GitHub/Microsoft        | Unified surface to direct/monitor/steer Copilot agent tasks across vendor agents (Anthropic, OpenAI, Google, Cognition, xAI onboarding) — **its console is literally named "Mission Control"**                                                              | Public preview since Universe Oct 2025; Enterprise AI Controls Mar 2026                                                                                                   |
| Emdash                  | General Action (YC W26) | Open-source (Apache-2.0) "Agentic Development Environment": 24 CLI agents at launch (Claude Code, Codex, Gemini, Amp, Cline, Cursor, Devin, Copilot, OpenCode), local or SSH-remote, worktree isolation — closest open-source philosophical match to DorkOS | ~2.4K stars, ~60K downloads, PH #3 May 2026                                                                                                                               |
| Conductor               | Melty Labs              | Native macOS app running multiple Claude Code/Codex agents in parallel worktrees with a review/merge dashboard                                                                                                                                              | The default "run Claude Code in parallel" pick; Apple-Silicon-only. NB: Microsoft also ships an unrelated "Conductor" (YAML multi-agent workflows) — disambiguate in copy |
| Claude Squad            | smtg-ai                 | Go TUI managing tmux sessions + worktrees for parallel terminal agents                                                                                                                                                                                      | AGPL-3.0; strong terminal-native mindshare                                                                                                                                |
| Omnara                  | Omnara                  | Mobile-first agent command center (iOS/Android, voice, remote approval); brands itself "open-source alternative to Claude Managed Agents"                                                                                                                   | Free + $9/mo; overlaps DorkOS mobile/remote pitch directly                                                                                                                |
| Devin                   | Cognition               | Cloud autonomous "AI software engineer"; MultiDevin fleets; Schedules feature                                                                                                                                                                               | Enterprise deployments (Goldman); $20/mo entry                                                                                                                            |
| Amp                     | Sourcegraph             | Proprietary CLI + VS Code agent; "zero data sharing" privacy tier                                                                                                                                                                                           | 40K+ teams in first two months of 2026                                                                                                                                    |
| Cline                   | Cline                   | Apache-2.0 VS Code extension + CLI (GA 2026); ACP; broad model support                                                                                                                                                                                      | 30K+ stars, large community                                                                                                                                               |
| Factory (Droid)         | Factory AI              | Terminal agent with coordinator dispatching specialized droids; multi-model routing; headless CI; "Missions" multi-agent orchestration                                                                                                                      | Cited as #2 terminal agent after Claude Code                                                                                                                              |

### Tier 2 (meaningful, narrower — build as data allows)

Vibe Kanban (ex-Bloop, now community Apache-2.0; kanban orchestration; maker shut down Apr 2026) · Crystal → Nimbalyst (Stravu; Crystal deprecated Feb 2026 for the paid successor) · Goose (Block, ~37K stars, MCP co-developer — distinct from Buzz) · Sculptor (Imbue; Docker-container isolation per agent, MIT) · Kilo Code (25K+ stars, official Roo Code migration destination, GA Apr 2026) · Jules (Google async cloud agent, public beta) · Warp + Oz (open-sourced Apr 2026; universal agent terminal + cloud orchestrator) · AgentsRoom (12-provider command center) · Windsurf · Zed agent panel.

### Dead tools → "alternatives to X" quick-win pages

- **Terragon** (Terragon Labs) — cloud background-agent orchestrator, **shut down 2026-02-09**, code open-sourced; still appears in roundups. docs.terragonlabs.com/docs/resources/shutdown
- **Roo Code** — **shut down 2026-05-15**; team pivoted to Roomote; official migration path Cline or Kilo Code.
- **Gemini CLI** — discontinued for individuals 2026-06-18, replaced by closed Antigravity CLI; expiring intent, low priority.

**Churn warning:** three products died/rebranded in ~7 months (Terragon, Roo Code, Crystal). Every comparison page needs a visible last-verified date and a re-verification cadence.

## Task B — comparison-page SEO/GEO mechanics (2025–2026)

**Structure that wins (human + AI):** quick verdict up top → both-product overview → comparison table → criterion-per-H2 breakdown → pros/cons → verdict → visible FAQ. Honest tone outperforms marketing tone: "why X might not be right for you" pages convert ~13.8% vs 2–5% SaaS average (Contadu); comparison/alternatives keywords convert 5.45–8.43% vs ≤1% informational (Vydera); each page needs a real pricing/feature table, at least one honest competitor advantage, sourced claims, and an owner re-checking on a schedule (GrowthOS).

**Structured data:** Google deprecated FAQ rich results 2026-05-07 (Search Console reporting gone Jun, API Aug 2026) — FAQPage markup still valid and consumed by Bing/Perplexity/LLMs, but **visible Q&A formatting does the real work**. For comparison pages: `SoftwareApplication` per product + `BreadcrumbList` per page + `ItemList` on hub/roundup pages. Extend DorkOS's existing JSON-LD conventions; adopt nothing exotic.

**Programmatic SEO:** Google's March 2026 core update targeted "scaled content abuse" — templated page farms lost 60–90%. Survivors have real data differentiation (the Zapier model: pages built on a database the competitor can't replicate). First-party comparison content from originator domains is now favored over aggregators. Build only as many pages as there is genuinely unique structured data to populate — depth over breadth.

**Canonicalization:** "X vs Y" and "Y vs X" are near-duplicates. One canonical URL per pair, self-first (e.g. `/compare/cursor` rendering "DorkOS vs Cursor"); never publish the reverse order; 301/canonical any variant.

**Hub vs pairwise:** both work, different intents. Pairwise = late-funnel, converts best. "Alternatives to X" hubs = earlier funnel, wider long-tail, cross-link into pairwise. Best programs run both. "Alternatives to <dead tool>" (Terragon, Roo Code) is a timely underserved niche.

**GEO/AEO:** only 38% of AI Overview citations come from top-10 organic (down from 76% in 2024); ChatGPT cites ~15% of retrieved pages and favors high-authority domains; AI Overviews appear in ~48% of searches. The formats converge: clear tables, criterion H2s, visible Q&A serve both human conversion and AI citation. Sources recommend ~50/50 SEO/GEO effort. DorkOS's existing llms.txt / per-page markdown / JSON-LD pipeline covers the infrastructure; net-new practice = the visible last-verified date (freshness signal in a category where products die within months).

## Sources

Task A: augmentcode.com/tools/open-source-agent-orchestrators · rustman.org/wiki/conductor-parallel-agents/ · htdocs.dev from-conductor-to-orchestrator · agentsroom.dev/blog/best-multi-agent-coding-tools · nimbalyst.com/blog/best-agent-management-tools-2026/ · claude.omnara.com + github.com/omnara-ai/omnara · winder.ai/ai-agent-harness-comparison/ · baeseokjae.github.io amp-code-review-2026 · theaiagentindex.com/compare/roo-code-vs-kilo-code · explainx.ai kilo-code guide · digitalapplied.com factory-ai review · blog.google jules · github.blog welcome-home-agents + how-to-orchestrate-agents-using-mission-control · aicatchup.com/tools/warp-agentic-development-environment · docs.terragonlabs.com shutdown · emdash.ai + github.com/generalaction/emdash.

Task B: vydera.com/en/lab/comparison-page-seo · getinbounder.com comparison-page-seo · contadu.com/high-converting-comparison-pages/ · usegrowthos.com how-to-build-saas-comparison-pages · intergrowth.com competitor-comparison-pages survey · gracker.ai is-programmatic-seo-still-effective-2026 · digitalapplied.com programmatic-seo-after-march-2026 · searchengineland.com/canonicalization-seo-448161 · contentpen.ai zapier case study · getpassionfruit.com FAQ deprecation · faqpage.com/schema-statistics · writer.com/blog/geo-aeo-optimization/.

Prior internal: `research/20260227_competitive_landscape_agent_infrastructure.md` · `research/20260405_ai_coding_agent_runtime_landscape.md` · `research/20260717_site-og-seo-ai-agents-world-class.md` · `research/20260302_faq_section_best_practices_developer_tools.md`.
