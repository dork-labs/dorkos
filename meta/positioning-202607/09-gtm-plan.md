# The GTM Plan: Alpha to Launched, Beginning to End

> Positioning review deliverable (July 2026). The operational go-to-market plan that turns `02-positioning.md` and `05-marketing-strategy.md` into a dated, ordered checklist. Inputs: the full Linear board audit (66 open issues, 2026-07-06), the codebase's actual instrumentation state (verified by grep, not memory), and the market/site research in docs 01-07.
>
> Honest starting state: **DorkOS is an alpha.** 44 releases and 1,244 commits, but ~zero outside users, which means the release count proves velocity, not stability. Three of the six launch-demo pillars have never been exercised by a stranger. This plan treats that as the first problem to solve, because a launch pointed at an untested product converts attention into refunds.

---

## Part 1: Strategy

### 1.1 Goal and definition of success

**Goal:** a successful public launch and a durable user base within ~14 weeks, bootstrapped, solo, $0 paid acquisition.

Success at day 90 (targets, not guarantees; ranges reflect honest uncertainty):

| Metric                                            | Floor (plan working) | Good  | Exceptional |
| ------------------------------------------------- | -------------------- | ----- | ----------- |
| GitHub stars                                      | 800                  | 2,500 | 10,000+     |
| npm installs/week                                 | 150                  | 500   | 2,000       |
| Newsletter subscribers                            | 150                  | 400   | 1,500       |
| Discord members                                   | 75                   | 250   | 1,000       |
| Marketplace packages (non-founder)                | 3                    | 10    | 30          |
| Outside contributors (merged PR)                  | 2                    | 6     | 20          |
| Known weekly-active instances (opt-in undercount) | 30                   | 100   | 500         |

If we miss every floor at day 90, the positioning (not the plan mechanics) is wrong; return to `02-positioning.md` with the accumulated evidence.

### 1.2 The motion

Open-source product-led community launch. One loop drives everything: **launch moment → GitHub stars → trending → discovery → install → word of mouth → stars.** The plan has four phases that serve that loop:

- **Phase 0 (Weeks 1-3): Stabilize and instrument.** Fix the blocker, smoke-test the untested pillars, wire analytics/email so launch traffic is measurable and capturable.
- **Phase 1 (Weeks 3-5): Build the funnel and run a quiet beta.** Site/README/video/security page; 15-30 hand-recruited testers break the product before strangers do.
- **Phase 2 (Weeks 6-9): The launch ladder.** Obsidian → Show HN → Reddit → Product Hunt, each a separate audience, fired in escalating order.
- **Phase 3 (Weeks 10-14): Compound.** Fleet reports, comparison SEO, marketplace seeding, contributor funnel; convert the spike into a slope.

### 1.3 Positioning, audience, channels (settled elsewhere, restated in one breath)

Mission control for every coding agent you run (Claude Code, Codex, OpenCode): one cockpit, scheduling, agents that message you and each other, self-hosted, MIT. Beachhead audiences in order: multi-agent Claude Code power users (HN/r/ClaudeAI/X), vendor hedgers, Obsidian dev-knowledge-workers, then AI-native small shops. Full rationale: `02-positioning.md`.

### 1.4 Alpha honesty as a strategy

We launch calling it what it is: a fast-moving open-source alpha built in public by one person and an agent fleet. This is not spin; it is the correct expectation-setting for HN and it converts bugs from embarrassments into participation invitations ("file it, watch an agent fix it overnight"). The brand's radical-honesty pillar does real work here. What alpha honesty does NOT excuse: data loss, broken installs, or dead first-run paths. Those are Phase 0.

---

## Part 2: Product readiness (build/fix/test list)

### 2.0 The hardening sequence and surface tiers (added 2026-07-06)

Not everything hardens at once, and not every surface launches at once. Two orderings govern the whole of Part 2:

**Hardening order** (funnel order x demo order x blast radius; each item must be solid before founder attention moves down the list):

1. **Install + first run** (the one-liner, cockpit opens, existing sessions appear): the top of the funnel; nothing below it matters if this wobbles.
2. **Session durability + multi-runtime listing** (DOR-189/188): the core trust contract; a cockpit that loses sessions is worse than no cockpit.
3. **Tasks end-to-end**: demo pillar; the autonomy proof.
4. **Relay/Telegram end-to-end**: demo pillar; required before Script 1 can film.
5. **Tunnel/mobile**: demo beat; if it resists hardening it gets _cut from launch claims_, not patched around.
6. **Marketplace + Claude Code superset compatibility**: the ecosystem-judo gate (§2.5).
7. **Security pass**: runs parallel in Week 3 regardless.
8. **Mesh multi-agent coordination**: explicitly last among core features; it is a second-visit story, not a launch claim.

**Surface tiers** (which client surfaces are launch-critical vs staged announcements):

| Tier | Surface                          | Status honesty                                                                       | GTM treatment                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Web cockpit via CLI install      | The product; all hardening above targets it                                          | The launch. All launch claims are Tier-A claims.                                                                                                                                                                                                                                                    |
| B    | Obsidian plugin                  | **Founder has never personally run it (2026-07-06); state unknown, possibly broken** | Smoke-test in Week 1-2 (one hour, clean vault). **Decision gate at end of Week 2:** solid or trivially fixable → keep as launch-ladder rung; broken or needs real work → pull it from the ladder entirely and stage it as its own post-launch announcement (see below). It must never delay Tier A. |
| C    | Desktop (Electron) app           | Dev boot fixed; packaged-build path + signing still open (DOR-155)                   | Not part of launch at all. Its own announcement when packaging/signing is done, likely month 3-4. Do not mention on the site until installable.                                                                                                                                                     |
| C    | A2A gateway, extensions platform | Real but niche                                                                       | Architecture content only; no announcements needed.                                                                                                                                                                                                                                                 |

**The "keep launching" cadence** (why tiers beat a monolith): every Tier-B/C surface that is _not_ in the initial launch becomes a future launch moment that re-kicks the star loop: "DorkOS is now in your Obsidian vault" and "DorkOS desktop is here" are each worth a fresh HN/Reddit/X cycle. Launching everything at once would spend all of it in one day, on surfaces we have not hardened. Staged rollouts are not a compromise; they are the content calendar for months 3-5. Each surface announcement ships with its own short video (see `08-demo-video-scripts.md`, state-based cuts).

Sourced from the 2026-07-06 Linear audit. Ticket references are live Linear issues.

### 2.1 Blockers (launch does not happen until these are green)

| #    | Item                                                                                  | Ticket                     | Why                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | **Codex/OpenCode transcripts vanish on server restart** (EventLog in-process only)    | DOR-189                    | Silent data loss on the multi-runtime headline. One restart during a Show HN eval = a public "it ate my session" comment.                                                                                                    |
| P0-2 | **Codex disk leak** (unbounded `logs_2.sqlite`, upstream 0.143.0)                     | DOR-188                    | Track the upstream release and adopt it; if still unfixed by Week 4, gate Codex behind a documented known-issue flag rather than launch a disk-eater.                                                                        |
| P0-3 | **Clean-machine install verification** (turbo graph omits a2a-gateway in fresh trees) | DOR-190 + new smoke ticket | The install one-liner is the top of the funnel. Verify `curl \| bash` and `npx dorkos` on a pristine macOS VM and Linux container, both Node 20 and 22. The bundled CLI is _probably_ fine; "probably" is not a launch word. |

### 2.2 The pillar test matrix (the audit's loudest finding)

Three demo pillars have **zero Linear coverage**, which for an unlaunched product means untested, not solid. Create one smoke ticket per cell; run each pillar end-to-end on a machine that is not the dev machine; file everything found.

| Pillar                                  | Test (as a stranger would)                                                                                              | Current coverage                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Install + first run                     | Fresh machine → one-liner → cockpit opens → existing Claude sessions appear                                             | Build-graph adjacency only                                                                                             |
| Schedule a task                         | Create cron task in UI → fires on time → run history correct → survives server restart                                  | Zero issues on the board                                                                                               |
| Telegram notification                   | Bind Telegram → agent finishes → message arrives → reply routes back                                                    | Zero functional issues ever filed                                                                                      |
| Tunnel / mobile                         | Enable tunnel → QR → phone cockpit → approve a tool call from phone                                                     | Zero issues, highest-risk blind spot                                                                                   |
| Runtime switching                       | Start sessions on all three runtimes → list/aggregate → restart server → all still listed (pairs with DOR-189)          | Only the two Codex bugs                                                                                                |
| Obsidian plugin                         | Install into a clean vault → session parity with web                                                                    | Zero issues (spot-check)                                                                                               |
| Multi-agent coordination (Mesh + Relay) | Register 2+ agents → one messages the other via Relay → budget envelopes enforce → topology reflects reality            | **Founder-flagged as not fully tested (2026-07-06)**; zero board coverage                                              |
| Marketplace compatibility               | Install a popular _Claude Code_ plugin (Anthropic marketplace format) into DorkOS → it works → harness sync projects it | Superset claim is a headline; must be proven on real third-party packages                                              |
| OpenCode local model                    | Bind a local model via OpenCode → run a session fully offline → confirm nothing leaves the machine                      | Zero coverage; underpins the "private" claim; the donated RTX 5090 (Vault/Compute Village partnership) is the test rig |
| Vault Cloud deployment (partner)        | DorkOS on a Vault VPS from our hardened template → secure defaults hold → tunnel/auth correct → cockpit reachable       | Partner co-marketing is gated on this exactly like every launch claim (`11-revenue-model.md` §6.5)                     |

**Demo-claim gate:** any pillar that fails its smoke test gets _removed from launch messaging_ until green, not talked around. In particular: multi-agent coordination is currently a **Script 3 / second-visit story, not a launch claim**, per the founder's own flag; Scripts 1 and 2 do not depend on it.

### 2.3 Should-fix during the launch window (visible papercuts, from the audit)

- DOR-99: usage status item permanently empty (reads as broken).
- DOR-122: dead marketplace enable/disable toggle in Settings (classic "this doesn't work" HN comment).
- DOR-75: identical sidebar titles for distinct sessions (hits the exact first-run flow).
- DOR-110: `operation_progress` standardization (flaky status when switching runtimes).
- DOR-164: status-strip cosmetic fix.
- DOR-168: Vitest CVE unification (dev-only, but Priya runs `npm audit`; cheap insurance).

### 2.4 Launch-enabling features (small, from `02-positioning.md` §4 and video script 1)

| Item                                                                                   | Size | Why now                                                                              |
| -------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| First-run onboarding polish (the 5-minute path as a guided sequence)                   | M    | The keynote. Every launch asset demos it.                                            |
| Nightly/run cost line in run history                                                   | S    | Script 1's "$4.87" beat; also genuinely useful.                                      |
| Telegram reply → steer a waiting session                                               | M    | Script 1's 2:47am beat; the single most shareable moment we can film.                |
| Fleet home screen v1 (status-shaped: who's working / needs me / done)                  | M-L  | The screenshot that sells; can be a filtered evolution of existing views.            |
| Security hardening pass + `/security` page + SECURITY.md + `dorkos doctor`-style check | M    | Pre-traction requirement (OpenClaw lesson).                                          |
| Morning briefing view (first daily open: what happened, what needs you, what it cost)  | M    | Closes the day-2 hook loop (`10-delight-and-hooks.md` §2-3); the retention feature.  |
| FTUE ritual polish: recognition moment copy + agent naming ceremony                    | S    | The investment mechanics of the 5-minute path; named things are kept.                |
| Tier-1 delight pack (7 small easter eggs, `10` §4)                                     | S    | Hours each; HN finds them and does the marketing. Ship with launch polish, Week 4-5. |

**Explicitly deferred** (per audit): harness-portability cluster, flow-engine server edition, desktop macOS polish (DOR-155), canvas/raw-transcript/context-idea tickets. Cost-aware routing waits for post-launch (it is Script 2's act, not launch-critical). **Cloud identity/auth (DOR-181/182) is parked through launch only**: it is the revenue foundation and resumes on schedule in month 3 (phase R1 of `11-revenue-model.md`).

### 2.5 The ecosystem-judo story (verify, then lead with it)

Three shipped facts compose into a claim bigger than any one feature (founder note, 2026-07-06):

1. **The marketplace is a strict superset of Anthropic's Claude Code plugin-marketplace format** → the entire existing Claude Code plugin ecosystem installs into DorkOS on day one, and DorkOS marketplaces work for plain Claude Code users too. We do not launch with an empty shelf; we launch with _their_ shelf.
2. **Harness sync** projects installed skills/rules/commands to every coding-agent harness on the machine (Cursor, Copilot, etc.) → DorkOS is not a silo; installing here upgrades everything you use.
3. **Tasks are skills with extra metadata** → any skill, including any just-installed marketplace skill, can be scheduled as an autonomous job.

The pipeline reads: **install any Claude Code plugin → it works everywhere you code → and it can run itself on a schedule.** Capability becomes automation in three clicks. No peer product (and no first party) composes these; it is nerdy, so it is presented as a _demo_, never as an explanation (see the Week 10 content slot and `07-website-changes.md` §4.6).

GTM handling: prove it in Week 1-2 (pillar matrix row above) on 3-5 popular real-world Claude Code plugins; if green, it gets a homepage section, a launch-thread beat ("your Claude Code plugins already work here"), and its own blog post. OpenCode's local-model support joins the same verification pass: it converts the "private" pillar from aspiration to demo (a session that provably never leaves the machine).

---

## Part 3: Instrumentation (analytics, email, telemetry)

Verified current state: PostHog on the site (consent-gated, DOR-170), opt-in marketplace install telemetry with a privacy contract, CLI update-check. **Nothing else.** No email capture, no product analytics, no error reporting, no tracing. Everything below respects the brand line: private by default, opt-in, payloads documented publicly.

### 3.1 Site analytics (Week 1; extends existing PostHog)

Events: `install_copy_click` (per method: curl/npm/brew), `github_click`, `docs_entered`, `video_play`/`video_complete`, `newsletter_signup`, `marketplace_pkg_view`. Funnels: visit → install-copy (the KPI), visit → newsletter, blog → install. UTM discipline on every posted link (`?utm_source=hn|reddit|x|obsidian|ph`) so launch-ladder rungs are attributable. All stays behind the existing consent gate.

### 3.2 Email capture (Week 1-2; new build)

- Provider: **Buttondown** (indie-standard, free tier to start, API + RSS-to-email, exportable = no lock-in).
- Surfaces: site footer input on every page; `/newsletter` page; end-of-blog-post inline; README badge link; post-install CLI message ("release notes + fleet reports, monthly: dorkos.ai/newsletter", printed once, never nagging).
- Cadence promise printed at signup: ~2/month, release notes + fleet report, no tracking pixels beyond Buttondown defaults (disable where possible).
- This list is the only owned, platform-proof channel we will have; it starts at zero and that is fine.

### 3.3 Product telemetry (Week 2-3; opt-in, first-run prompt)

An anonymous heartbeat, **off by default**, offered once at first run with the payload shown verbatim before consent (the marketplace telemetry privacy-contract pattern already in the repo generalizes):

```json
{
  "instance": "<random-uuid>",
  "version": "0.45.0",
  "os": "darwin-arm64",
  "runtimes_configured": ["claude-code", "codex"],
  "surfaces": ["web", "obsidian"],
  "counts": { "agents": 4, "tasks": 2, "relay_adapters": 1 }
}
```

Weekly ping to a dorkos.ai endpoint (reuse the install-telemetry route pattern). No prompts, no code, no paths, no session content, ever; payload documented on a public `/telemetry` page and in `docs/`. This is how "known weekly-active instances" in §1.1 becomes measurable at all; accept that it undercounts (privacy-first products fly partially blind, by design).

### 3.4 Error reporting (Week 2-3; opt-in)

Crash/error capture in server + CLI behind the same consent: recommend **Sentry** (free tier) or self-hosted GlitchTip if the dependency feels wrong. Scrub paths/env. Without this, every beta bug report starts with "can you send me your logs," which burns tester goodwill.

### 3.5 OpenTelemetry (Week 3; local-first observability)

Instrument the server with the OTel SDK: spans for session turns, runtime calls, relay dispatch, task runs; exporter **off by default** (console/file exporter in debug mode). Purpose: (a) supporting beta users ("run with `--debug-trace`, send the file"), (b) the fleet-report content engine gets real numbers (turn latencies, run durations), (c) future-proofs perf work. Do not build dashboards yet; that is post-launch.

### 3.6 The metrics dashboard (Week 3; an agent Task, dogfooding)

A scheduled DorkOS Task (weekly) that pulls GitHub stars/forks, npm downloads, PostHog funnels, Buttondown count, telemetry actives, marketplace installs into one markdown scorecard, relayed to Telegram and archived in the repo. This is simultaneously: our KPI review, a dogfood demo, and the skeleton of the public Fleet Report content.

### 3.7 Feedback and bug collection (added 2026-07-06)

The alpha's most valuable output is feedback, and a self-hosted dev tool collects it differently than a SaaS. Principles first: **GitHub is the canonical bug tracker** (public, dev-native, doubles as activity proof), **Discord is the conversation layer**, **the app helps you report but never surveils you**, and the site's "nothing phones home" claim stays true.

**Build (Week 2-3, small):**

1. **In-app "Report an issue"** in the command palette and help menu, plus a `dorkos feedback` CLI command. Both open a **prefilled GitHub issue** (new-tab URL): version, OS/arch, runtimes configured, active surface, sanitized config flags; the user sees and can edit everything before submitting. This is the dev-correct version of "the little feedback tab": zero third-party widget, zero tracking, removes the "gather my environment info" friction that kills alpha bug reports.
2. **GitHub issue templates** (bug / feature / runtime-specific) with labels wired to the Linear sync, and a triage agent (DorkBot) that labels, dedupes, and asks for missing repro info within the hour: feedback response speed is itself marketing during launch weeks, and an agent doing first-touch triage is the dogfood story again.
3. **Discord #feedback + #bug-reports** with a pinned template; beta cohort gets a standing weekly "what sucked this week?" thread. For the 15-30 quiet-beta testers, ask each (with consent) for one screen recording of their first 15 minutes: the single highest-value onboarding artifact money can't buy.

**Surveys and scores (deliberately staged):**

- **Now through launch: no NPS, no in-app survey.** With under a few hundred users the numbers are noise, and an unprompted rating widget inside an alpha control panel reads as consumer-SaaS (anti-persona energy). Qualitative beats quantitative until the funnel is real.
- **Week 10-12: the Sean Ellis PMF test**, by email to actives (via Buttondown) and pinned in Discord: "How would you feel if you could no longer use DorkOS?" (very / somewhat / not disappointed, plus "what's the main benefit?" free text). The 40% very-disappointed threshold is the honest PMF gauge and directly feeds the day-90 review; it needs ~40+ responses to mean anything, hence the timing.
- **Post-GA (not this quarter): NPS if ever.** For OSS dev tools, GitHub stars, retention of telemetry actives, and the Sean Ellis score carry more signal than NPS; add NPS only if a future paid tier needs a board-metric.
- **PostHog surveys**: usable on the _site/docs_ (e.g., a docs-page "was this helpful?"), never inside the self-hosted app. "Finish the PostHog integration" therefore means §3.1 (site events + funnels) and optionally docs micro-surveys; it does not mean product analytics in the app: the opt-in heartbeat (§3.3) is the whole story there, by design.

**Routing rule so feedback doesn't scatter:** everything converges to GitHub issues within a day: Discord reports get an issue link (agent-drafted), X/Reddit complaints get a reply + filed issue, beta notes get triaged weekly. One queue, publicly visible, with the fix rate on display: that visible fix velocity is the alpha's best retention feature.

---

## Part 4: Timeline, week by week

Founder-time budget assumption: this is the main job for 14 weeks. Agents (Tasks + subagents) carry the mechanical load; the founder carries voice, judgment, and replies. Weeks slip; order does not.

### Phase 0: Stabilize + instrument (Weeks 1-3)

**Week 1**

- Fix DOR-189 (transcript durability). Start DOR-188 upstream watch.
- Run the pillar test matrix (§2.2) on clean machines; file everything; triage the 41 un-triaged Linear issues while at it (the board is 62% Triage).
- Instrumentation: PostHog events + funnels; Buttondown + site email surfaces.
- Quick wins from `06-marketing-tactics.md` Block A: repo description, topics, social-profile coherence.
- Content: first build-in-public X post (the honest one: "5 stars, 44 releases, launching this quarter, here's the plan").

**Week 2**

- Fix the worst of what the pillar matrix found (unknowable now; budget the whole week).
- DOR-190 clean-install verification on VMs; papercuts DOR-99, DOR-75.
- Telemetry heartbeat + error reporting behind consent; `/telemetry` page.
- README overhaul (positioning, GIF placeholder, 5-minute path, honest alpha status).
- **The Obsidian gate (end of week):** one hour in a clean vault. Solid or trivially fixable → Week 6 Path A. Broken or real work → Path B, and the plugin re-stages as its own Week 10-12 announcement. Decide once, in writing, here.
- Content: X thread on the transcript-durability fix (build-in-public receipt #1).

**Week 3**

- Security pass: hardening audit (bindings, tunnel auth, MCP key), SECURITY.md, `/security` page, self-check command.
- OTel spans + debug exporter; weekly metrics-scorecard Task live.
- Feedback rails (§3.7): in-app "Report an issue" + `dorkos feedback` (prefilled GitHub issues), issue templates, DorkBot first-touch triage.
- 5-minute onboarding path polish begins; cost-line-in-run-history ships.
- Site fixes wave 1 from `07-website-changes.md` §1 (the 404s, Slack contradiction, FAQ).
- Film **Cut 0 ("The Cockpit", 45s)** the moment install + durability are green; it becomes the README GIF and interim site hero.
- Content: blog post "How DorkOS stores your sessions (and why a restart can't eat them anymore)"; X posts x3.

### Phase 1: Funnel + quiet beta (Weeks 3-5, overlaps)

**Week 4**

- **Quiet beta starts:** hand-recruit 15-30 testers (friendlies, Obsidian forum lurkers, X mutuals, 1-2 Discords where presence exists). Private Discord channel. Ask for: one fresh install, one scheduled task, one Telegram bind, brutal notes.
- Site fixes wave 2: prelude timing, scroll reveals, install scramble, GitHub-with-stars in header, runtimes section.
- Telegram-reply steering lands (Script 1's beat).
- Marketplace seeding sprint begins (target 20 packages by Week 6).
- Content: X posts x3 (beta invite post among them); newsletter issue #0 to whoever exists ("what this is, what's coming").

**Week 5**

- Beta feedback fix week (budget all of it; beta bugs are launch bugs found early).
- Film **Script 1 ("2:47 AM")**: 90s + 30s cuts; screenshot pipeline (Playwright) produces the money shots; hero visual lands on the site.
- Launch assets: Show HN draft + first-comment founder story + objection sheet; PH kit; Obsidian forum post draft.
- Fleet home screen v1 if on track; otherwise cut scope to "fleet strip" on existing screens (do not slip launch for it).
- Content: blog "A night with DorkOS, measured" (real run receipts); X x3; newsletter #1.

### Phase 2: The launch ladder (Weeks 6-9)

**Week 6: the rehearsal rung (contents decided by the Week-2 Obsidian gate, §2.0).**

- **Path A (Obsidian smoke test passed):** submit the plugin to the Obsidian community directory; forum post ("thinking and doing in the same place"); Obsidian Discord. Fix what Obsidian users find within 48h (small pond, fast goodwill). Content: X launch thread; blog "Your notes were in the room: DorkOS inside Obsidian".
- **Path B (Obsidian pulled from the ladder):** the rehearsal audience becomes the quiet-beta cohort widened to ~50 via one honest X post + r/ClaudeAI soft post ("open beta, break it before HN does"). The Obsidian plugin exits launch messaging entirely (site, README, FAQ mention it as "in development") and is re-staged as its own announcement in Week 10-12, after real hardening, with its own video (`08` state-based cuts). Priya remains the persona; her channel just fires later, and fires better for being real.
- Either path: this week exists to shake bugs loose in a friendly room before Week 7. Do not skip it to launch sooner.

**Week 7: Show HN (the main event).**

- Tuesday-Thursday, ~8-10am ET. Title: "Show HN: DorkOS: self-hosted mission control for Claude Code, Codex, and OpenCode."
- Founder story + honest alpha framing in first comment; reply to every substantive comment for 12 hours (clear the calendar); objection sheet loaded.
- Same-day: X thread mirror, Discord open to public, newsletter launch note.
- Contingency: if it does not front-page, do NOT repost for 4+ weeks; the ladder continues regardless (HN allows respectful retries after meaningful changes; the Week 11 slot is the retry window with new features + traction proof).

**Week 8: Reddit wave + Product Hunt.**

- r/ClaudeAI (angle: multi-runtime cockpit + "your Claude Code plugins already work here"), r/selfhosted (self-hosted + privacy angle), r/LocalLLaMA (angle: **fully-local sessions via OpenCode local models**, verified in Phase 0), r/ObsidianMD (plugin angle): staggered across the week, native tone, each a genuine post not a link-drop.
- Product Hunt Thursday with HN/Reddit momentum and assets.
- Content: "what we fixed from launch feedback" changelog post (receipts culture).

**Week 9: Consolidation.**

- Fix-sprint on launch-week findings; personal thank-yous to every contributor/reporter.
- First **public Fleet Report** (the flagship content engine, now with real outside users in the story).
- Awesome-list submissions completed (agent-drafted PRs, founder submits).
- Newsletter #2: launch retrospective with real numbers (transparency compounds).

### Phase 3: Compound (Weeks 10-14)

**Week 10:** comparison pages ship (vs OpenClaw / Conductor / Vibe Kanban / Claude Squad / plain Claude Code) + freshness-watch Task. Weekly rhythm locks in: 3 X posts, 1 blog/fleet report, biweekly newsletter, daily replies.
**Week 11:** intent-SEO pages from customer-voice quotes (~10 pages, agent-drafted, founder-edited). HN retry window if Week 7 missed (new hook: fleet reports + what changed).
**Week 12:** film **Script 2 ("One Cockpit, Any Agent")** with the compare-screen v1 if built; else its 30s runtime-switch cut. "Build a package in 10 minutes" guide + template repo; package-of-the-week slot starts.
**Week 13:** contributor funnel (curated good-first-issues, CONTRIBUTING refresh, fast-review SLA); pitch one podcast/meetup talk with 90-day numbers.
**Week 14:** 90-day review against §1.1 targets; decide next quarter (routing v1 + Script 2 full, or double down on what moved). Update this doc with actuals.

### Beyond week 14: the revenue arc (months 4-6)

The monetization phases run behind this plan, gated on its retention signals, and are specified in `11-revenue-model.md`: R0 foundations ride the launch (Sponsors, pricing-philosophy page, tunnel/multi-instance heartbeat fields); R1 free Cloud accounts + Founding Crew SKU (month 3); R2 Cloud Solo GA = first revenue (month 4, ~$8/mo founding-locked); R3 Crew design partners (month 5); R4 Crew GA at ~$15/seat (month 6). Revenue floor at month 6: $1k MRR. The Week-2 pricing-philosophy page (what stays free forever, what will cost money and why) is this arc's launch-window prerequisite.

---

## Part 5: The content calendar (14 weeks of posts)

Cadence: X 3x/week (Mon/Wed/Fri), blog ~1x/week, newsletter biweekly, Reddit/HN per ladder, YouTube per video asset. Agent pipelines draft everything (`06-marketing-tactics.md` Block C); founder edits and posts. Titles are working titles.

| Wk  | X (3 posts: themes/hooks)                                                                                                                                                                                                                     | Blog / long-form                                                                                          | Other channels                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | "5 stars, 44 releases, 1,244 commits. We never launched. That changes this quarter." · the cockpit teaser GIF · "what 3 coding agents in one UI looks like"                                                                                   | "DorkOS is an alpha. Here's the honest state of it." (also the new README bones)                          | Newsletter page live                                                    |
| 2   | transcript-durability fix thread (before/after) · pillar-testing confession ("we tested our own demo like a stranger; here's what broke") · **ecosystem-judo proof clip ("I installed a Claude Code plugin into DorkOS and it just worked")** | "How DorkOS stores sessions across three runtimes"                                                        |                                                                         |
| 3   | security-page announcement ("the OpenClaw lesson, taken seriously") · `dorkos doctor` clip · run-history cost line screenshot ("last night cost $4.87")                                                                                       | "Threat model for a self-hosted agent cockpit"                                                            | Newsletter #0                                                           |
| 4   | beta invite ("15 seats: break my agent cockpit") · first beta-found bug fixed same-day receipt · Telegram-reply-from-bed clip                                                                                                                 | "Get a Telegram message when your coding agent finishes" (intent page #1)                                 | Quiet-beta Discord opens                                                |
| 5   | Script-1 film stills · fleet screen first look · "what beta testers broke this week" thread                                                                                                                                                   | "A night with DorkOS, measured" (real receipts)                                                           | Newsletter #1; YouTube: 90s "2:47 AM"                                   |
| 6   | Path A: Obsidian launch thread · "thinking + doing in one place" clip · user quote RT / Path B: open-beta thread · beta-bug-fixed receipts · cockpit clip                                                                                     | Path A: "Your notes were in the room" / Path B: "Open beta: break it before HN does"                      | Path A: **Obsidian directory + forum + Discord** / Path B: widened beta |
| 7   | Show HN mirror thread · "answers to everything HN asked" · install-spike screenshot with real numbers                                                                                                                                         | HN first comment (the founder story, canonical version)                                                   | **Show HN**; Discord public; newsletter launch note                     |
| 8   | PH launch post · r/ClaudeAI highlights RT · "what we fixed in 72 hours" receipts thread                                                                                                                                                       | "Launch week: everything that broke and what we did about it"                                             | **Reddit wave (4 subs) + Product Hunt**                                 |
| 9   | Fleet Report #1 thread ("my agents merged 11 PRs this week; here are the transcripts") · contributor shout-out · marketplace package spotlight                                                                                                | **Fleet Report #1** (the flagship format)                                                                 | Newsletter #2: launch retro with numbers; awesome-list PRs              |
| 10  | "DorkOS vs X" teaser (honest table screenshot) · "install → sync → schedule" pipeline demo (a plugin becomes an autonomous nightly job in 3 clicks) · user fleet screenshot RT                                                                | Comparison pages ship (5) + "Every Claude Code plugin already works in DorkOS" (the ecosystem-judo essay) |                                                                         |
| 11  | intent-page highlights ("run Claude Code on a schedule") · Fleet Report #2 thread · behind-the-scenes: the agent that writes these posts                                                                                                      | Fleet Report #2 + 10 intent pages                                                                         | HN retry window (if needed)                                             |
| 12  | "hire an agent in 10 seconds" marketplace clip · package-of-the-week #1 · Script-2 teaser (three-runtime race)                                                                                                                                | "Build a DorkOS package in 10 minutes"                                                                    | YouTube: Script 2 cut                                                   |
| 13  | good-first-issues thread ("come build with the fleet") · contributor PR spotlight · Fleet Report #3                                                                                                                                           | "How one person maintains a monorepo with an agent fleet" (architecture essay)                            | Podcast/talk pitch goes out                                             |
| 14  | 90-day transparency thread (all the real numbers vs targets) · community montage · "what's next"                                                                                                                                              | "90 days in public: the numbers"                                                                          | Newsletter #3                                                           |

Standing rules: every post links with UTM; every claim has a screenshot or transcript; nothing auto-posts (agents draft, founder publishes); reply-guy radar (`06` #19) runs daily from Week 1 and its best drafted answers count toward the X cadence.

---

## Part 6: Launch-day runbooks (condensed)

**Show HN day:** post 8-10am ET Tue-Thu · founder story as first comment within 2 minutes · calendar cleared 12h for replies · status page green, tunnel demo instance warm, `install` endpoint load-checked · objection sheet open (wrapper? / Claude Code web exists? / OpenClaw? / security? / SaaS?) · every bug filed publicly in-thread with the Linear link ("filed, watch it get fixed") · metrics snapshot before and after.

**Flop contingencies:** HN no-traction → keep shipping, retry Week 11 with changed hook + new proof; PH mediocre → it is a backlink, move on; Obsidian cold → the plugin still recruits beta users one by one; a launch-day catastrophic bug → honest pinned comment, fix in public, post the postmortem (in this category a great postmortem outperforms a mediocre launch).

**A launch-day security report:** acknowledge within the hour, thank publicly, fix before feature work, disclose per SECURITY.md. This is the one runbook that must never be improvised.

---

## Part 7: Operating cadence and ownership

- **Owner of everything:** the founder. **Draft-writers of most things:** agents (release pipeline, fleet report assembly, comparison freshness, reply radar, screenshot pipeline, metrics scorecard: all scheduled DorkOS Tasks by end of Phase 0).
- **Weekly rhythm (from Week 1):** Monday metrics scorecard review (agent-produced) → pick the week's 3 X posts from agent drafts → Friday fleet-report assembly. One weekly hour of Linear triage keeps the board honest (it was 62% un-triaged at audit time).
- **Kill criteria for content formats:** any format that produces zero engagement for 4 consecutive weeks gets cut in favor of doubling the best performer. The calendar above is the opening bid, not scripture.
- **The Vault Cloud partnership (added 2026-07-06):** one workstream, gated like everything else. Phase 0-1: author the hardened deploy-on-Vault template and pass its pillar-matrix smoke test. Launch window: a "run DorkOS on a Vault box" docs guide + one mutual blog/X beat (their audience is SMB verticals we cannot reach; UTM-tagged like every channel). Post-launch: Vault listed as one inference option among providers, never a default. Full posture and rules: `11-revenue-model.md` §6.5.
- **Founder hours: resolved 2026-07-06.** The Vault "VP" title is symbolic (no role, no comp, minimal time); the founder is effectively full-time on this plan, as its assumptions require. Remaining Vault action: soften the title in their public materials (`11-revenue-model.md` §6.5 rule 5).
