# Positioning Review 2026-07: Overview

> The July 2026 repositioning study. One founder question drove it: "If we were starting from scratch today, how would we position DorkOS for massive success?" This doc is the executive summary; the numbered docs carry the detail.

## The documents

| Doc                        | What it answers                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-market-landscape.md`   | Where the market is, where it's headed, where the giants will steamroll, how to beat them                                                                                          |
| `02-positioning.md`        | The from-scratch positioning, target niches, and the few product moves that multiply everything                                                                                    |
| `03-feature-ranking.md`    | Every shipped feature, rank-ordered by marketing value, with benefit language                                                                                                      |
| `04-brand-doc-changes.md`  | Concrete edits to brand-foundation, customer-voice, value-architecture, personas                                                                                                   |
| `05-marketing-strategy.md` | The strategy: phase 0 funnel fixes → launch ladder → compounding engines                                                                                                           |
| `06-marketing-tactics.md`  | 31 low-cost tactics, tagged by automatability, low-hanging fruit first                                                                                                             |
| `07-website-changes.md`    | Prioritized dorkos.ai changes with reasons (fixes, conversion killers, story drift, additions)                                                                                     |
| `08-demo-video-scripts.md` | Three flagship demo beat sheets ("2:47 AM", "One Cockpit Any Agent", "The Org"), each with a real-vs-aspirational ledger                                                           |
| `09-gtm-plan.md`           | The operational GTM plan: alpha stabilization, instrumentation (analytics/email/telemetry/OTel), Linear-audit build list, 14-week timeline, full content calendar, launch runbooks |
| `10-delight-and-hooks.md`  | The Hooked-loop analysis, FTUE/daily-ritual priorities, and the easter-egg/delight catalog with incorporation map                                                                  |
| `11-revenue-model.md`      | The monetization model: why-they-pay taxonomy, the OSS/Solo/Crew/Enterprise ladder, fence rules, and the month 0-6 revenue arc riding behind the launch                            |

## The ten findings that matter

1. **DorkOS has never launched.** Public repo, 5 stars, no Show HN, no Product Hunt, no Obsidian directory release, despite 1,244 commits, 44 releases, and a live marketplace. Every distribution card is still in hand. This is a launch problem, not a growth problem, and that is good news.

2. **The category arrived and got named while we were building.** "Meta-harness" is the term of the year; buyers compare tools instead of needing evangelism. The window to be a definitive answer in that comparison is roughly now.

3. **The defensible wedge is exactly what we already built: vendor-neutral coordination, self-hosted.** First parties (Anthropic Managed Agents, Codex cloud, Jules) are absorbing single-vendor orchestration and will never orchestrate competitors. The OSS peer group (Conductor, Vibe Kanban, Claude Squad) is thin worktree dashboards. Nobody else has scheduling + messaging + discovery + marketplace + durable sessions across three vendors' agents, running on your machine.

4. **Multi-runtime is the headline and it is currently a secret.** The site, README, and GitHub description still tell a Claude-Code-only story. The single cheapest positioning win available is saying, everywhere, "Claude Code, Codex, OpenCode: one cockpit."

5. **Autonomy demotes from hero to proof.** "Runs while you sleep" is being commoditized by first parties for their own agents. The unsolved, growing pain is fleet chaos and vendor sprawl. New door: mission control for the agents you already run. Same thesis underneath: intelligence doesn't scale, coordination does.

6. **Security is the category's open wound and our opportunity.** OpenClaw's CVE + 155k exposed instances defined how the press covers self-hosted agents. A published threat model, secure-by-default posture, and a security page turn our biggest categorical risk into a differentiator. This is a pre-launch requirement.

7. **The website's problem is behavioral, not aesthetic.** The design system and narrative are right. But every feature-card docs link 404s, the boot prelude blocks first paint on every visit, scroll reveals leave whole viewports blank, the install command renders scrambled, and the site never shows the product. Fix conversion before buying traffic with a launch.

8. **The dogfood is the unfair marketing asset.** DorkOS is built by agent fleets coordinated by DorkOS. Weekly "fleet reports" with real run receipts are content no competitor can honestly produce, and they double as founder-brand building from a zero-audience start.

9. **The biggest product multipliers are small.** (a) Harden the 5-minute magic path into a rehearsed keynote (install → your sessions are already there → schedule → Telegram ping). (b) Ship a fleet home screen: one view of every agent, every runtime, every project. (c) v1 of cost-aware runtime routing makes neutrality _do_ something no one else does. No new subsystem needed.

10. **Say no to the same things, louder.** No hosted SaaS this phase, no enterprise motion, no consumer broadening, no benchmark games, no vapor modules in marketing (Wing/Loop), no launch before the funnel is fixed.

## Late additions (2026-07-06, after the initial ten findings)

- **The product is an alpha, and the plan now says so.** A Linear audit (66 open issues) found one true launch blocker (DOR-189: Codex/OpenCode transcripts vanish on server restart), one gated risk (DOR-188 Codex disk leak, upstream), and, louder than any bug, three launch pillars with zero test coverage (Telegram notifications, tunnel/mobile, task scheduling) plus founder-flagged untested multi-agent coordination. `09-gtm-plan.md` front-loads a stabilization phase and a demo-claim gate: nothing untested gets marketed.
- **The ecosystem judo** (`02-positioning.md` §6): marketplace-is-a-superset-of-Claude-Code's-format x harness sync x tasks-are-skills composes into "install any Claude Code plugin → it works in every tool you use → it can run itself on a schedule." We launch with the largest plugin ecosystem in the world already on the shelf. Verify against real plugins first, then it earns a homepage section and a launch beat.
- **OpenCode brings local models**, which turns the privacy claim into a demo: a session that provably never leaves the machine, in the same cockpit as the cloud runtimes.
- **The revenue model exists** (`11-revenue-model.md`, 2026-07-06): MIT core free forever; DorkOS Cloud monetizes remote reach (Solo ~$8/mo), team coordination + spend visibility (Crew ~$15/seat), and compliance (Enterprise, later), on an R0-R4 arc behind the launch: free cloud accounts month 3, first revenue month 4, Crew GA month 6, $1k MRR floor. Spec #268's account-first identity (DOR-181/182, in review) is the foundation; "no hosted SaaS this phase" in finding 10 means hosted _instances_, and stands: the Cloud is a coordination layer, not compute.

## The plan in one paragraph

Fix the funnel (site + README + security page + 5-minute path), reframe every surface around the multi-runtime cockpit, then fire the launch ladder in order: Obsidian community → Show HN → Reddit → Product Hunt, each armed with a 60-second cockpit video and honest founder story. Behind it, run the agent-powered engines: release-to-everywhere pipeline, weekly fleet report, comparison/intent SEO, marketplace seeding. Measure by stars/week, installs/week, and newsletter growth. Founder time converges to: replies, one weekly fleet report, one monthly essay; agents do the rest.

## Where the market goes next (the bets we're placing)

Ranked by confidence in `01-market-landscape.md` §4: cross-vendor becomes table stakes → agent work shifts from sessions to standing organizations (names, roles, memory, schedules) → governance/safety becomes the buying criterion → agents become installable artifacts (the app-store moment; our marketplace is early) → cost-aware routing emerges as the "kernel scheduler" of the stack. DorkOS is architecturally early to all five; the strategy is to say so out loud and ship the small proofs first.
