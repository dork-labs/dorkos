# GTM Tracker

> The single itemized checklist for the whole positioning/GTM effort. Source of truth for _what's next_; the reasoning lives in the numbered docs (`09-gtm-plan.md` is the spine). Check items off as they finish; add the completion date after the checkbox when useful. Target dates assume Week 1 = week of **2026-07-06** and slip together, in order, if life happens. Keep this file updated with every working session (agents included).

**Legend:** `[ ]` not done · `[x]` done. **(GATE)** = blocks everything after it in its section. Dates are week-ending targets.

## 0. Blocking decisions (before the clock starts)

- [x] 2026-07-06 — Founder-hours decision: the Vault "VP" role is symbolic (no role, no paperwork, no comp; Vault is unfunded/pre-revenue); founder is effectively full-time on DorkOS. Gate removed (`11` §6.5/§7).
- [ ] Confirm launch-week target on the calendar (Show HN aimed at week of Aug 17) — by Jul 8
- [ ] Ask Ikechi to soften the Vault blog before it leaves staging: drop or downgrade the "VP of Product" title (symbolic titles conflict with our honesty pillar and muddy vendor neutrality) and verify the "two-time exited founder" phrasing — by Jul 10

## Phase 0: Stabilize + instrument (Weeks 1-3, Jul 6-26)

### Product blockers (`09` §2.1)

- [x] 2026-07-10 **(GATE)** DOR-189: Codex/OpenCode transcripts survive server restart — Jul 12 · shipped in PR #202 (durable SQLite session-event store; spec `specs/durable-event-log/`, ADR 260710-024641); acceptance verified: turn → process kill → fresh boot → identical transcript; cross-process durability now protected in CI
- [ ] DOR-188: Codex disk leak: upstream 0.143.0 adopted, or Codex gated behind a documented flag — decision by Aug 1
- [ ] DOR-190 + clean-machine install verified (curl + npx, macOS VM + Linux, Node 22/24) — Jul 19

### Pillar smoke tests (`09` §2.2, one ticket each; failures pull the claim from launch messaging)

- [x] 2026-07-10 Install + first run, on a machine that isn't the dev machine — Jul 12 · **PASS** (DOR-234; dorkos@0.44.0, clean node:20 + node:22 containers) — but found DOR-245: npm package ships without `core-extensions/`, so the Marketplace tab is missing for every npm install; fix before launch
- [x] 2026-07-10 Schedule a task end-to-end (fires, history, survives restart) — Jul 12 · **FAIL → FIXED same day** (DOR-235; DOR-248 + DOR-249 shipped in PR #199 with the end-to-end scenario re-verified: fire → completed → restart → history intact + next fire clean). DOR-242 (PR #198), DOR-245 (PR #200), DOR-250 (PR #201) also fixed same day; still open: DOR-256 (marketplace extension fails to compile in the packaged CLI — esbuild runtime-dependency decision needed)
- [ ] Telegram notification end-to-end (bind → notify → reply routes) — Jul 12 · _run 2026-07-10 (DOR-236): **BLOCKED on founder phone legs** (no bot token exists; ~10-min checklist on the ticket). Reply routing + approval buttons verified in code; DOR-240: "agent finishes → phone buzzes" is NOT automatic (agent must call `relay_notify_user`), DOR-239: `canInitiate` toggle unenforced_
- [ ] Tunnel / mobile (QR → phone cockpit → approve from phone) — Jul 12 · _run 2026-07-10 (DOR-237): **BLOCKED on ngrok authtoken** (mandatory, no free fallback). Exposure guard + session gate verified correct; DOR-242 (High): `dorkos auth enable` → sign-in 500s on fresh prod installs (`BETTER_AUTH_SECRET` never generated) — breaks the whole mobile path; DOR-244: copy undersells setup friction_
- [x] 2026-07-10 Runtime switching x3 + restart persistence — Jul 12 · **FAIL as worded** (DOR-238; codex closest to green, opencode session ids change across restart (DOR-251), claude-code split-brains when `CLAUDE_CONFIG_DIR` is set (DOR-250, root-caused to `transcript-reader.ts`), and codex/opencode transcripts open empty post-restart = DOR-189)
- [ ] Obsidian plugin clean-vault test → **(GATE) Week-2 Path A/B decision recorded** — Jul 19
- [ ] Multi-agent Mesh+Relay coordination smoke test — Jul 19
- [ ] Marketplace superset: 3-5 real Claude Code plugins install + work — Jul 19
- [ ] OpenCode local model: fully offline session (RTX 5090 rig) — Jul 26
- [ ] Vault deployment: hardened template passes secure-defaults test — Jul 26
- [ ] Triage the 41 un-triaged Linear issues — Jul 12

### Papercuts (`09` §2.3)

- [ ] DOR-99 usage status item — Jul 19
- [ ] DOR-75 identical sidebar titles — Jul 19
- [ ] DOR-122 dead marketplace toggle — Jul 26
- [ ] DOR-110 operation_progress standardization — Aug 2
- [ ] DOR-164 status-strip fix + DOR-168 Vitest CVE unification — Jul 26

### Instrumentation (`09` Part 3)

- [ ] PostHog events + funnels + UTM discipline (site) — Jul 12
- [ ] Resend Broadcasts + email capture surfaces (footer, /newsletter, post-install line) — Jul 19 (ADR 260707-025214: reuse existing Resend, free ≤1k contacts; RSS-to-email via a DorkOS scheduled Task, double opt-in via the Better Auth token pattern)
- [ ] Opt-in telemetry heartbeat + `/telemetry` page (incl. tunnel/multi-instance fields) — Jul 26
- [ ] Opt-in error reporting (Sentry or GlitchTip) — Jul 26
- [ ] OTel spans + debug exporter — Jul 26
- [ ] Weekly metrics-scorecard Task live (agent-run) — Jul 26
- [ ] Feedback rails: in-app "Report an issue" + `dorkos feedback` + issue templates + DorkBot triage (`09` §3.7) — Jul 26

### Security (pre-traction requirement)

- [ ] Hardening audit (bindings, tunnel auth, MCP key) — Jul 26
- [ ] SECURITY.md + `/security` page + threat model — Jul 26
- [ ] `dorkos doctor`-style self-check — Aug 2

### Marketing surfaces, wave 1

- [x] 2026-07-09 — GitHub repo description + topics fixed — Jul 8 (description per `06` tactic #1; swapped 4 stack topics for codex/opencode/orchestration/meta-harness at the 20-topic cap)
- [ ] README overhaul (positioning, 5-min path, honest alpha status) — Jul 19 (positioning done 2026-07-09 via PR #156 — "You, multiplied." + multi-runtime opener on repo + npm READMEs, atop PR #148's plain-language rewrite; still open: verify 5-min path + honest alpha status before checking off. Same day: homepage/site reframe PRs #157-#160 merged — hero, feature catalog, FAQ, legal pages, marketplace chrome)
- [x] 2026-07-06 — Site fixes wave 1: 14 docsUrl 404s, Slack contradiction, FAQ corrections (`07` §1) — Jul 26 (PR #92)
- [ ] Social-profile coherence (X bio, org page, footer) — Jul 12
- [ ] GitHub Sponsors live — Jul 12
- [ ] Pricing-philosophy page (what stays free forever) (`07` §4.7) — Jul 26
- [ ] Awesome-list + directory submissions (agent-drafted PRs) — Jul 26
- [ ] First build-in-public X post ("5 stars, 44 releases, we never launched") — Jul 10

## Phase 1: Funnel + quiet beta (Weeks 4-5, Jul 27-Aug 9)

- [ ] Quiet beta: 15-30 testers recruited, private channel, first-15-minutes recordings requested — Aug 2
- [ ] Site fixes wave 2: prelude timing, scroll reveals, install scramble, GitHub-with-stars header, runtimes section (`07` §2-3) — Aug 2 (partial 2026-07-06 PR #92: prelude timing + scroll reveals + install scramble done, plain GitHub header link added w/o stars; still open: star-count header, runtimes section — both gated on verification per Decision 17)
- [ ] Launch-enabling features (`09` §2.4): cost line — Jul 26 · Telegram reply-steering — Aug 2 · morning briefing view — Aug 9 · FTUE ritual polish — Aug 9 · fleet home screen v1 (or scoped fleet strip) — Aug 9
- [ ] Tier-1 delight pack (7 easter eggs, `10` §4) — Aug 9
- [ ] **Cut 0 "The Cockpit" (45s) filmed** → README GIF + interim hero — Jul 26
- [x] 2026-07-06 — Screenshot pipeline (Playwright) producing themed money shots — Aug 2 (PR #102, far beyond spec: two-phase record/process pipeline + raw media library + 34 real-UI assets + 9 polished loops + `capturing-product-media` skill; premium features catalog with bento layout shipped alongside)
- [ ] Script 1 "2:47 AM" filmed in the cut the pillar tests earned (90s + 30s) — Aug 9
- [ ] Marketplace seeded to ~20 packages — Aug 9
- [ ] Beta feedback fix week completed (budgeted, not skipped) — Aug 9
- [ ] Launch kit: Show HN post + first comment + objection sheet + PH gallery + stickers/wallpaper — Aug 9
- [ ] Newsletter #0 and #1 sent — Aug 9

## Phase 2: Launch ladder (Weeks 6-9, Aug 10-Sep 6)

- [ ] Week-6 rehearsal rung per the Obsidian gate: Path A (Obsidian directory + forum + Discord) or Path B (widened open beta) — Aug 16
- [ ] **Show HN** (Tue-Thu, 8-10am ET; 12h reply window cleared) — week of Aug 17
- [ ] Discord public + newsletter launch note — Aug 23
- [ ] Reddit wave: r/ClaudeAI, r/selfhosted, r/LocalLLaMA, r/ObsidianMD (staggered, native) — Aug 30
- [ ] Product Hunt — Aug 27
- [ ] "What we fixed in 72 hours" receipts post — Aug 30
- [ ] Fleet Report #1 published (the flagship format) — Sep 6
- [ ] Launch retro newsletter with real numbers — Sep 6
- [ ] Vault co-marketing beat (only if the deploy template passed) — Sep 6

## Phase 3: Compound (Weeks 10-14, Sep 7-Oct 11)

- [ ] Comparison pages x5 + freshness-watch Task — Sep 13
- [ ] Ecosystem-judo essay + install→sync→schedule demo clip — Sep 13
- [ ] Intent-SEO pages (~10, from customer-voice quotes) — Sep 20
- [ ] HN retry (only if Week 7 missed; new hook required) — week of Sep 21
- [ ] Sean Ellis PMF survey to actives (needs ~40+ responses) — Sep 27
- [ ] "Build a package in 10 minutes" guide + template repo; package-of-the-week starts — Sep 27
- [ ] Script 2 filmed (compare-screen cut or 30s runtime-switch) — Oct 4
- [ ] Contributor funnel: good-first-issues, CONTRIBUTING refresh, review SLA — Oct 4
- [ ] Podcast/talk pitch sent with 90-day numbers — Oct 11
- [ ] **90-day review vs targets; update `09` with actuals; decide next quarter** — Oct 11

## Revenue arc (months 3-6, riding behind; `11` §6)

- [ ] R1: free Cloud accounts GA + crew numbers + Founding Crew SKU + Solo price pre-announcement — Sep 30
- [ ] R2: relay/broker service + push + multi-instance fleet view + billing spec + **Solo GA (first revenue)** — Oct 31
- [ ] R3: Crew design partners (5-10 teams): orgs, shared agents v1, private registry MVP, spend dashboard v1 — Nov 30
- [ ] R4: **Crew GA** ~$15/seat; month-6 review vs $1k MRR floor — Dec 31

## Staged announcements (dates float on their gates)

- [ ] Obsidian announcement + "The Vault" video (if Path B pulled it from launch) — target Sep-Oct
- [ ] Desktop app announcement + "The Desktop" video (gated on DOR-155 signed packaged build) — target Oct-Nov
- [ ] "Offline" local-model clip published — with the r/LocalLLaMA wave or R1
