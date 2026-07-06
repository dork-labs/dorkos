# Marketing Strategy: Bootstrapped, Solo, Launching From Zero

> Positioning review deliverable (July 2026). The strategy layer; the tactical checklist lives in `06-marketing-tactics.md`, and the dated, operational end-to-end plan (alpha stabilization, Linear-audit build list, instrumentation, 14-week calendar, runbooks) is `09-gtm-plan.md`, which supersedes this doc's phase sketch where they differ. Note added 2026-07-06: the product is treated as an **alpha**; a stabilization-and-instrumentation phase now precedes everything below, and no untested pillar gets marketed (demo-claim gate, `09` §2.2). Constraint set: one founder, no budget, no audience (5 GitHub stars, ~1k LinkedIn, unverified X following), unlimited access to frontier models and a product that dogfoods itself. Goal: durable traction while staying independent.

## 0. The strategic read

DorkOS has spent five months compounding product and zero units of distribution. In this category, distribution compounds through exactly one primary loop:

**launch moment → GitHub stars → trending → discovery → users → word of mouth → stars.**

Every peer that won (OpenClaw most of all) won on this loop. Nothing else (SEO, content, community) matters until the loop has been kicked at least once, and everything else exists to re-kick it. Therefore the strategy is: **prepare the surfaces, then fire a sequence of launch moments, then feed the loop on a weekly cadence with receipts from the dogfood.**

## 1. Phase 0: Make the click-through convert (1-2 weeks)

A launch spike is wasted on a leaky funnel. Before any push:

1. Website fixes and product visuals per `07-website-changes.md` (404s, prelude, reveal timing, hero screenshot/video, runtimes section, GitHub link with stars).
2. **README as landing page**: the repo README is where launch traffic actually lands. It needs the positioning, the cockpit GIF, the 5-minute path, and honest status. Update the repo description (currently "...for Claude Code").
3. **The 5-minute magic path** hardened end-to-end (install → sessions already visible → schedule → Telegram ping). Every launch asset demos this path; it must not have a single rough edge.
4. **Security pre-work**: threat-model page, secure defaults audit, `dorkos doctor` style self-check. Non-negotiable before traction (see landmines); also a differentiator at launch ("the meta-harness that took OpenClaw's lesson seriously").
5. Seed the marketplace to ~20 genuinely useful packages so the flywheel surface doesn't look empty on day one.

## 2. Phase 1: The launch ladder (fire in sequence, ~4-6 weeks)

Order matters: each rung builds proof for the next, and each is a separate audience so a miss on one doesn't burn the others.

1. **Obsidian community first** (lowest risk, most concentrated): release the plugin to the Obsidian directory + forum + Discord. Priya's channel. Small, passionate, underserved; generates the first real testimonials and hones the pitch in a friendly room.
2. **Show HN** (the main event): "Show HN: DorkOS: self-hosted mission control for Claude Code, Codex, and OpenCode." The customer-voice corpus is literally built from HN threads; the audience is pre-qualified. Founder story in the first comment (Section 8 housing → 30M users → built this for myself), demo video, honest limitations list. HN rewards exactly the radical-honesty voice the brand already has.
3. **r/ClaudeAI, r/selfhosted, r/LocalLLaMA, r/ExperiencedDevs** (staggered, native tone per sub, days apart, never cross-posted verbatim).
4. **Product Hunt** (after HN, using its momentum and assets).
5. **The talk/video flywheel**: one excellent 15-minute "I run a fleet of agents that built this product" talk, pitched to meetups/conferences and cut into clips. Steinberger's talk was worth 10x stars; a solo founder's equivalent is a recorded deep-dive that earns reposts.

**Launch positioning note**: lead with the multi-runtime cockpit + fleet screen (differentiation), prove with the overnight story (emotion), close with self-hosted/MIT/security (trust). Not the other order.

## 3. Phase 2: The compounding engines (ongoing, mostly automatable)

Ranked by expected compounding per unit of founder time:

1. **Build-in-public with receipts (X + blog).** The unfair asset: DorkOS develops itself. Nightly maintenance runs, agent-written PRs, relay pings, /flow cycles: publish the artifacts weekly. Nobody else in the category can post "here is last night's run history" from a product that is itself the proof. This is the founder's personal-brand engine and the product demo in one.
2. **Comparison and intent SEO.** "DorkOS vs OpenClaw/Conductor/Vibe Kanban/Claude Squad", "best meta-harness 2026", plus intent pages mapped 1:1 from customer-voice quotes ("run Claude Code on a schedule", "get a Telegram message when Claude Code finishes", "run Claude Code and Codex together"). The category's search gravity is forming now; honest spec-level comparisons in the brand voice will rank and convert. llms.txt + AI-crawler allowlisting already in place gives an answer-engine edge.
3. **Ecosystem seeding (marketplace).** Weekly featured package, a "build a package in 10 minutes" guide, PRs welcoming community packages. Skills marketplaces compound (ClawHub: 5.7k → 44k in months); the flywheel needs ~50 packages and a few external contributors to self-sustain.
4. **Being everywhere lists are made:** every awesome-list (agent orchestrators, harness engineering, CLI agents, self-hosted, Obsidian plugins), alternativeto, selfh.st, MCP registries. One-time cost each, permanent discovery.
5. **Community (Discord) once there is a pulse**: open it at launch but treat it as support until there are ~100 active users; premature community-building is founder-time quicksand.

## 4. What we deliberately do not do

- No paid acquisition (no budget, wrong audience psychology, and OSS devs distrust ads).
- No enterprise sales motion, no "book a demo."
- No consumer/no-code broadening, ever (anti-persona discipline).
- No hosted SaaS in this phase (capital-intensive, head-on vs first parties; revisit only after OSS traction, per the ICP's open-core hypotheses).
- No engagement-bait or hype language (brand: honest by design; the audience's spam detectors are the best in the world).
- No launch before Phase 0 is done (a viral moment against a broken funnel is unrecoverable; you get one first launch).

## 5. Monetization posture (superseded 2026-07-06 by `11-revenue-model.md`)

The full model now exists: MIT core free forever; DorkOS Cloud (Solo ~$8/mo, Crew ~$15/seat, Enterprise later) monetizes remote reach, team coordination, spend visibility, and compliance, on the R0-R4 arc targeting first revenue in month 4. Marketing implications that bind _this_ plan: the email list and Discord are the future paid launch's channels (build from day one, as below); the **pricing-philosophy page** (what stays free forever, and why) ships in the launch window as the rug-pull vaccine; GitHub Sponsors and the Founding Crew patronage SKU are live trickles that gate nothing.

## 6. How we measure it (lightweight, honest)

- **Loop health**: GitHub stars/week, npm installs/week, marketplace install telemetry (already opt-in), Discord joins.
- **Funnel health**: site → install click-through (PostHog already integrated, consent-gated), README → docs flow.
- **Retention proxy**: weekly returning tunnel/Console usage is invisible (self-hosted, by design); use release-note traffic, update-check pings if/when added (opt-in only), and community signal instead. Accept imperfect measurement as a cost of the privacy position; never compromise the position for analytics.

## 7. The Jobs lens (what a world-class product marketer would insist on)

1. **One moment, repeated everywhere**: the morning review. Phone buzzes at 2:47am; you read it at 7:00; the work is done and waiting. Every asset (hero video, HN post, talk, stickers) is a variation of this single moment. Simplify until the demo needs no narration.
2. **Show, never describe**: no asset without the cockpit visible. The site currently describes a control panel while showing none of it; invert that.
3. **Say no in public**: the "What DorkOS is NOT" section is the most Jobs thing in the brand corpus. Put it on the site. Confidence through refusal.
4. **Make the tribe visible to itself**: "Built by dorks" becomes real when users have something to wear/show: stickers at launch, a wall of named agent teams ("meet Atlas, Scout, Sentinel"), users' fleet screenshots retweeted. Identity, not features, is what people share.
5. **The keynote is the onboarding**: the first five minutes of product use must be as rehearsed as a demo. Jobs would spend the whole budget there, and so should we (it is also the only part of this plan that is pure product work).
