# Marketing Tactics: Low-Cost, Automatable, Low-Hanging Fruit First

> Positioning review deliverable (July 2026). The execution list for `05-marketing-strategy.md`. Ordered by (impact ÷ effort), lowest-hanging first within each block. Tags: [auto] = fully automatable with agents/Tasks today, [semi] = agent-drafted + human-approved, [human] = founder voice required. Anything posted publicly under Dorian's name should always get a human pass; automation drafts, humans publish.

## Block A: Free wins lying on the ground (this week, mostly hours each)

1. **Fix the GitHub repo description** [human, 2 min]: "Intelligence doesn't scale. Coordination does. Mission control for Claude Code, Codex, and OpenCode: scheduling, messaging, agent discovery. Self-hosted, MIT." Add topics/tags (ai-agents, claude-code, codex, self-hosted, mcp, orchestration, meta-harness).
2. **README overhaul** [semi]: hero GIF of the cockpit, the positioning line, the 5-minute path, badges (npm version, MIT, CI), honest status section, link ladder (site/docs/discord). The README is the real landing page for launch traffic.
3. **Site quick fixes** from `07-website-changes.md` §1 [semi]: the 404 docs links above all.
4. **Submit to every relevant list** [semi, one-time each]: awesome-agent-orchestrators, awesome-harness-engineering, awesome-cli-coding-agents, awesome-selfhosted, awesome-mcp lists, alternativeto.net, selfh.st, Obsidian plugin directory (the big one), openalternative.co. Agent drafts the PRs; human submits.
5. **Social profiles coherence** [human, 1 hr]: X bio, GitHub org page, dorkos.ai footer all carry the same one-liner and link. dork-labs org README with the logo and thesis.
6. **A /security page + SECURITY.md** [semi]: threat model, secure defaults, disclosure policy. Two hours of writing that becomes a durable differentiator and a prerequisite for everything else.
7. **Newsletter capture** [semi]: one email field on the site ("release notes + fleet reports, monthly"), wired to Resend Broadcasts (ADR 260707-025214, reusing the existing Resend stack). Owned audience starts at zero; start it anyway.

## Block B: The launch assets (weeks 1-3, the real work)

8. **The 60-second cockpit video** [human directs, agent-assisted]: screen capture of the 5-minute path compressed to 60s, silent-with-captions version for embeds/X, voiceover version for YouTube. This single asset feeds the hero, README, HN, PH, and every social post. Playwright infra (`apps/e2e`) can drive the app for perfectly reproducible captures [auto for re-takes on each release].
9. **Screenshot pipeline** [auto]: a Task that boots dev, seeds demo data, drives Playwright through the money screens (fleet view, session, approval, task run, topology, marketplace), and exports themed PNGs. Run on every release: screenshots never go stale, and each release tweet gets fresh visuals for free.
10. **Show HN post + first comment** [human]: drafted, reviewed cold a week later, tested on one friendly reader. The founder story belongs in the first comment, not the post.
11. **Product Hunt kit** [semi]: gallery from the screenshot pipeline, maker story from /story assets.
12. **Launch-week FAQ/objection sheet** [semi]: pre-written honest answers to the predictable HN objections ("isn't this a wrapper", "what about Claude Code web", "OpenClaw exists", "security?", "SaaS when?"). Answering fast and well in-thread is half of HN performance.
13. **Stickers/wallpaper** [semi]: the DORK mark + "You slept. They shipped." Printable PDF and a wallpaper pack download; costs nothing digital, seeds tribe identity.

## Block C: The content engine (ongoing, agent-powered)

The principle: **the dogfood writes the content.** DorkOS runs agents that build DorkOS; every run produces publishable artifacts. Pipelines below are buildable with Tasks + Relay today.

14. **Release → everywhere pipeline** [auto with human publish]: on each release tag, an agent turns the changelog into: a blog post (already happens), an X thread draft, a Discord announcement, and a newsletter section. Founder approves in one place (Relay message with the drafts).
15. **The Fleet Report** [semi, weekly]: "what my agents did this week": real run history, PRs merged by agents, costs. The build-in-public flagship; screenshots from pipeline #9. This is the content only DorkOS can honestly produce.
16. **Customer-voice intent pages** [semi]: each pain quote in `customer-voice.md` is a search query. Generate one honest, useful page per theme ("how to run Claude Code on a schedule", "get Telegram notifications from your coding agent", "run Claude Code and Codex side by side"), each ending in the 5-minute path. ~10 pages, evergreen, high intent, zero competition on most.
17. **Comparison pages** [semi]: vs OpenClaw, vs Conductor, vs Vibe Kanban, vs Claude Squad, vs "just Claude Code". Spec-level, honest about their strengths, updated by a monthly agent freshness check [auto] that watches competitor releases and flags drift.
18. **Architecture essays** [human, monthly]: the Transport/hexagon story, the durable-SSE rebuild, the runtime conformance suite, "how the marketplace does atomic installs". Priya-bait; HN-viable individually; establishes the "reads like the source" credibility.
19. **Reply-guy radar** [auto-monitor, human-reply]: an agent watches HN/Reddit/X for "claude code schedule", "agent orchestrator", "openclaw alternative", "codex + claude" threads and drops drafts in a Relay channel. Human posts genuinely helpful answers (never automated posting; that way lies spam-ban and brand death).
20. **YouTube shorts/clips** [semi]: each release's best visual moment as a 30s clip from the screenshot/video pipeline. Low expectations, compounding library, feeds search.
21. **llms.txt/answer-engine upkeep** [auto]: already shipped; add a Task that regenerates it each release so AI assistants recommend DorkOS with current facts. (When people ask Claude/ChatGPT "how do I orchestrate coding agents", being in the answer is free distribution.)

## Block D: Community and ecosystem (post-launch)

22. **Marketplace seeding sprint** [semi]: ~20 → 50 quality packages; each package page is also an SEO surface and a tweet. A "package of the week" slot in the newsletter/X cadence [semi].
23. **"Build a package in 10 minutes" guide + template repo** [semi]: lowers the contributor bar; every community package is marketing made by someone else.
24. **Discord** [human]: open at launch, support-first posture, no forced community programming until ~100 actives.
25. **Obsidian community care** [human]: forum thread responses, plugin release notes, one "thinking + doing environment" essay for the tools-for-thought crowd. Small pond, deep loyalty, testimonial source.
26. **Contributor funnel** [semi]: good-first-issues curated by an agent weekly, CONTRIBUTING.md refresh, fast PR review SLA (agent-assisted first-pass reviews already exist in-repo).
27. **Cross-ecosystem guest surface** [human]: MCP registry listings, an "control DorkOS from Cursor/ChatGPT via MCP" demo post; a Latent Space / selfhosted-podcast pitch once numbers exist.

## Block E: AI-generation leverage (image/video/voice)

28. **OG-image generation per page** [auto]: already dynamic via next/og; extend to blog posts and marketplace packages with per-item visuals.
29. **Agent avatar packs** [auto]: generated identity art for marketplace agents (fits the personality system, makes fleet screenshots look great, zero marginal cost).
30. **Voiceover for videos** [semi]: TTS voiceover on the silent captures for YouTube versions; founder voice preferred when time allows, TTS acceptable for minor clips.
31. **Do not** AI-generate: testimonials, benchmark claims, community appearances, or any "person" content. (Honesty pillar; also the audience detects it instantly.)

## Sequencing summary

- **Week 1:** Block A complete + start #8/#9.
- **Weeks 2-3:** Block B; Phase 0 site fixes land; marketplace seeding starts.
- **Week 4+:** fire the launch ladder (Obsidian → HN → Reddit → PH) with Block C pipelines already running so the spike lands on a live, breathing project.
- **Forever:** #14/#15/#17-freshness/#19/#21 run on Tasks; the founder's recurring manual load converges to: one weekly fleet report, replies, and one monthly essay.
