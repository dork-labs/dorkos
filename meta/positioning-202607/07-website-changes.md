# Website Changes: dorkos.ai

> Positioning review deliverable (July 2026). Sources: full `apps/site` code/content audit, a live browser review of dorkos.ai (desktop viewport, homepage + /features + /marketplace), and the brand/meta docs. Ordered by priority within each section. Each item says what to change and why.

## How to read this

The site is well-crafted and the narrative arc (prelude → hero → villain → pivot → timeline → subsystems → honesty → install → identity) is intact and emotionally correct. The problems fall into four buckets:

1. **Fixes** - things that are broken today (404s, contradictions)
2. **Conversion killers** - craft choices that cost visitors in the first 10 seconds
3. **Story drift** - the product outgrew the site; its strongest current differentiators are invisible
4. **Strategic additions** - pages/sections the marketing strategy needs

---

## 1. Fixes (broken today, do first)

### 1.1 Every feature-card "Learn more" docs link 404s

All 14 `docsUrl` values in `src/layers/features/marketing/lib/features.ts` point to doc paths that do not exist (`/docs/console`, `/docs/tasks`, `/docs/relay`, `/docs/mesh`, `/docs/mcp`, `/docs/tunnel`, adapter pages, etc). The real tree is `/docs/guides/*`, `/docs/concepts/*`, `/docs/integrations/*`.

**Why it matters:** Priya (the architect persona) clicks "Learn more" as her first evaluation step. A 404 on the first click reads as abandonment, the exact fear both personas have ("is this another dead project?"). This is the single highest-damage bug on the site.

**Change:** remap every `docsUrl` to a real page; add missing doc pages for question-prompts and file-uploads or drop their links; add a CI check (or e2e test) that every `docsUrl` in `features.ts` resolves.

### 1.2 Slack adapter status contradiction

`features.ts` says Slack Adapter is `beta` with a full benefits list; `subsystems.ts` says `coming-soon`; the server has a matured Slack adapter per the changelog (Socket Mode, streaming, reactions, threading, v0.14-0.20 era). One of these is wrong on the site, and the two site surfaces contradict each other.

**Change:** verify actual adapter state in `apps/server`, set both data files to the same truthful status. Honesty is a stated brand pillar; a self-contradicting status table undermines it.

### 1.3 FAQ inaccuracies

- "An agent is an AI coding tool — like Claude Code, Cursor, or Codex": Cursor has no DorkOS runtime. Say "Claude Code, Codex, or OpenCode", which is also a stronger claim (all three actually work).
- "Session data stays in Claude Code's local transcript files": stale single-runtime framing. Codex sessions live in SDK threads, OpenCode in its sidecar store. Reword to "session data stays on your machine, in each runtime's native local store."

**Why:** these answer the exact questions technical evaluators ask, and both currently contain claims a five-minute source read disproves. Priya reads source.

### 1.4 Dead marketing components

`AboutSection`, `ContactSection`, `CredibilityBar`, `HowItWorksSection`, `NotSection`, `PhilosophyGrid`, `ProblemSection`, `ProjectsGrid`, `SystemArchitecture`, `UseCasesGrid`, `Hero`/`TasksAnimation` are exported but unreferenced by any route. Delete them (repo rule: no dead code) or consciously revive what's useful (CredibilityBar is interesting, see 4.4).

### 1.5 Decide the fate of /story

`/story` is a fully-built founder-narrative page (with presentation mode) linked from nowhere, absent from sitemap and nav. Either it's a private pitch deck (fine, add a comment saying so) or it's wasted marketing asset. Recommendation: rework it into a public "Why DorkOS" page and link it from the "about" nav item (see 4.3). Founder story is one of the few unfakeable assets a solo bootstrapped product has.

---

## 2. Conversion killers (first-10-seconds problems)

Observed live in the browser, in order of cost:

### 2.1 The prelude blocks the entire first paint, every visit

"DorkOS is starting." types out character-by-character on a black screen before any content is visible, and it replays on every navigation to the homepage (observed twice in one session). It cannot be skipped by scrolling.

**Why it matters:** launch-day traffic (HN, X) gives you 3-5 seconds before bounce. The boot-sequence idea is charming exactly once, to a visitor who already cares. Right now it taxes every first impression and every return visit.

**Change:** cut total prelude time to under 1.2s (the original decision spec'd ~1.2s), skip instantly on any input (scroll/click/key), and persist a `sessionStorage` flag so it never replays within a session. Consider `prefers-reduced-motion` = skip entirely.

### 2.2 Scroll-triggered fades leave whole viewports blank

At normal scroll speed, multiple full screens render as empty cream space (timeline section, honesty section, identity close were all blank in captures until re-scrolled). Content only fades in when the IntersectionObserver fires, and fast scrolling outruns it.

**Why it matters:** a skimming visitor (everyone from HN) sees a mostly-empty page and concludes there's nothing below the fold. The narrative arc only works if the narrative is visible.

**Change:** make reveal animations fast (≤300ms), trigger earlier (rootMargin), and never start elements at opacity 0 for longer than one frame after they enter the viewport; or animate transform only, with opacity floor ~0.4. Audit at 2x scroll speed.

### 2.3 The install command is unreadable during its scramble animation

The `curl` one-liner renders as scrambled glyphs (`cu#* **&?& _-<_%!@++...`) that resolve very slowly; three consecutive screenshots seconds apart never showed the final command.

**Why it matters:** this is the moment of conversion. Kai's buying trigger is "one command, runs immediately." A garbled command at the moment of intent is friction exactly where friction is most expensive; it can also read as broken.

**Change:** resolve the scramble in under 1s, or scramble only once on first reveal and never on re-entry; the copy button must always be instantly available with correct content (verify it is).

### 2.4 Zero product imagery anywhere

The homepage, features page, and feature cards contain no screenshot, video, or live demo of Console. The activity feed is simulated text. For a product whose stated quality bar is "world-class UI/UX", the site shows no UI.

**Why it matters:** Kai's listed buying trigger is "sees a demo showing agents running overnight and producing real output." Every successful peer product leads with the cockpit visual. A control panel product that never shows the control panel forfeits its strongest proof.

**Change (biggest single win on this list):** add a real Console visual to the hero or immediately after it. Best form: a 30-60s silent screen capture (session streaming + tool approval + a Task firing + a Telegram notification arriving), plus per-feature screenshots on `/features/[slug]` pages. Static hero screenshot is an acceptable v1.

### 2.5 No social proof / GitHub presence in the header

Header nav is logo + "DOCS". GitHub appears only as a small footer icon. No star count, no "open source" signal above the fold besides badges deep in the install section.

**Why:** for OSS dev tools the GitHub link IS the credibility check (both personas' first move). Add a GitHub link with star count to the header, and once stars are non-embarrassing, a star badge near the hero CTA.

---

## 3. Story drift (the product outgrew the site)

### 3.1 Multi-runtime is invisible; it's now the headline differentiator

Months of engineering went into the `AgentRuntime` abstraction: Claude Code, Codex, and OpenCode all work today, with per-session binding and a conformance suite. The site mentions this only in docs prose. Meanwhile "works with Claude Code AND Codex AND OpenCode, switch per session" is:

- a claim none of the single-vendor cockpits can make,
- the concrete answer to "what if Anthropic ships this themselves?" (the #1 strategic risk),
- and the honest version of "bring your agent, we make it autonomous" from the litepaper.

**Change:** add a runtimes section to the homepage (three logos, one sentence: "Your agents, any vendor. Claude Code, Codex, and OpenCode today; one interface, per-session choice."), a `runtimes` feature card (there is no runtime entry in the 14-item catalog and no `product` enum value for it), and an FAQ entry "Which agents does DorkOS work with?".

### 3.2 Marketplace is a top-nav page but not part of the story

The marketplace exists, is live with real packages, is installable from CLI/app/MCP, and doesn't appear in the homepage narrative, the features catalog (no `marketplace` product enum), or the FAQ.

**Change:** add it as a subsystem card ("Marketplace: install agents, plugins, and skill packs with one command") and a homepage beat after subsystems: the ecosystem proof. Marketplaces signal "alive project with a community", which directly answers the abandonment fear.

### 3.3 Obsidian plugin and desktop app: two client surfaces, zero mentions

Priya is the secondary persona and the Obsidian plugin is her entire entry point; it is mentioned nowhere on the marketing site. The Electron desktop app is likewise absent.

**Change:** a "Where DorkOS lives" strip (browser / desktop app / Obsidian / your phone via tunnel) either in the subsystems section or as its own row. Four surfaces is a real differentiator and currently a secret.

### 3.4 Features catalog missing shipped capabilities

No cards for: Runtimes (3.1), Marketplace (3.2), Workspaces, Agent identity/personas, Canvas, Session durability (refresh-proof streams), Skills, harness sync. Some belong in the catalog, others in docs only; but today the catalog undersells the product by roughly half.

**Change:** audit `features.ts` against the real feature inventory (see `03-feature-ranking.md` in this directory) and add the missing user-facing ones. Rank `featured` by the new positioning, not by build order.

### 3.5 Hero headline predates the pro-human positioning decision

"Your agents are brilliant. They just can't do anything when you leave." was flagged in the copy log (Decision 16 follow-ups) as centering human absence as the problem. The approved reframe direction exists in the meta docs ("Your agents are brilliant. They just have no way to coordinate.") but never shipped.

**Change:** ship the reframe, or better, test the sharper coordination claim against it once the positioning work (02-positioning.md) is settled. Also update the OG image headline to match (it currently bakes in the old line).

### 3.6 Wing and Loop still sold as "coming soon"

Neither has a package in the repo; Loop points at an external product. Selling two vapor modules alongside six real ones dilutes the honesty brand pillar. Keep at most one forward-looking item, clearly marked, or cut both from the subsystems grid and keep them in the litepaper/vision page.

---

## 4. Strategic additions

### 4.1 A comparison/alternatives page

"DorkOS vs OpenClaw", "DorkOS vs [meta-harness]", "DorkOS vs plain Claude Code" (final list pending the market research in `01-market-landscape.md`). Honest, spec-level, in brand voice.

**Why:** these queries are how developers actually search once a category has more than one player; they're also the cheapest high-intent SEO available to a bootstrapped product. The honesty voice makes DorkOS unusually suited to credible comparison pages.

### 4.2 Real content on /blog beyond release notes

44 release posts prove the project is alive (excellent, keep), but there is zero narrative/technical content: no "how I run 10 agents", no architecture posts, no build-in-public essays. Release notes retain users; essays acquire them.

**Change:** add 1-2 flagship essays (launch narrative, architecture deep-dive) and mark categories so the blog index leads with them. Details in `06-marketing-tactics.md`.

### 4.3 An "about/why" page from the /story assets

The origin story (Section 8 housing → self-taught → 30M users → built DorkOS for himself) is the brand's provenance stamp and currently unreachable. Rework `/story` into `/about` (or `/why`), link it from the pill nav "about" item (which currently anchors to the homepage identity section), add it to the sitemap.

### 4.4 Proof strip once numbers exist

The dead `CredibilityBar` component suggests this was planned. When honest numbers exist (GitHub stars, npm downloads/week, marketplace installs, Discord members), add a quiet monospace strip under the hero. Until then, keep it out; fake-feeling proof is worse than none.

### 4.5 A compatibility section: "Your plugins already work here" (added 2026-07-06)

New homepage section (and eventually its own page) presenting the ecosystem-judo combination from `02-positioning.md` §6 as a demo, not an explanation:

- **Headline:** "Your plugins already work here."
- **Subhead:** "DorkOS speaks Claude Code's marketplace format, so the whole ecosystem installs on day one. Harness sync carries what you install to every tool you use. And any skill can run on a schedule."
- **Body:** a single looping 20-second capture: install a real Claude Code plugin → it appears in Cursor via harness sync → one click turns its skill into a nightly task. Three captions, no prose.

**Why:** it answers the two biggest silent objections at once (empty-ecosystem and switching-cost) using shipped facts, and no competitor can put this section on their site. Placement: after the subsystems grid, before the honesty section. **Gate:** ship only after the superset claim is verified against popular real-world plugins (`09-gtm-plan.md` §2.5); the honesty pillar applies to compatibility claims doubly.

Related copy updates once verified: the marketplace page subhead gains "compatible with the Claude Code plugin format", and the FAQ gains "Do my Claude Code plugins work with DorkOS?"

### 4.6 The three-step Plan (StoryBrand, added 2026-07-06)

Restructure the install section as an explicit numbered plan with named beats, identical across site, README, and FTUE: **1. Install. 2. Meet your fleet** (your sessions appear; name your first agent; connect Telegram). **3. Hand off the night.** StoryBrand's insight is that heroes need a visible, finite plan before they act; the current install section shows methods (curl/npm/brew) but no journey. The three steps also mirror the FTUE's four moments (`10-delight-and-hooks.md` §2), so the site promises exactly what the product delivers.

### 4.7 The pricing-philosophy page (added 2026-07-06, revenue arc R0)

A short `/pricing` (or `/philosophy`) page shipped in the launch window, _before_ anything costs money: what is free forever (the MIT core, all of it, in writing), what will cost money and why (things that run on our servers or coordinate teams: DorkOS Cloud), and the promise that nothing shipped free ever moves behind a paywall. Content from `11-revenue-model.md` §3-4.

**Why:** pre-announcing the fence is the rug-pull-anxiety vaccine (HashiCorp/Redis taught the audience to ask "when does this get taken away?" before adopting anything MIT). It converts the honesty pillar into a monetization asset and makes the eventual Solo/Crew launches feel like kept promises instead of pivots.

### 4.8 Mobile pass

Not fully verified in this review (window resize was inconclusive); the floating pill nav and simulated feed looked plausible at desktop widths. Before any launch push, run the full narrative on a real 390px viewport: prelude, feed, timeline, install tabs. The quality bar ("every surface works on mobile") is a stated brand standard.

---

## 5. What NOT to change

- **The cream/retro-tech design system.** It was unanimously endorsed in the copy rounds, it's distinctive in a sea of dark-mode dev tools, and it photographs well in screenshots/social cards. The problems above are behavioral (timing, reveals), not aesthetic.
- **The narrative structure.** Villain cards → pivot → timeline is the right arc and matches the value-architecture method. Fix visibility and pacing, keep the story.
- **The identity close.** "Built by dorks. For dorks. Run by you." and the signed Dorkian note are the tribe filter working as designed.
- **Honesty section.** Keep; move nothing. It is the credibility anchor the personas need.
- **Install methods presentation** (one-liner / npm / brew tabs with badges): correct and complete; only the scramble timing needs work (2.3).
