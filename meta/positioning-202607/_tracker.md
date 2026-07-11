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
- [x] 2026-07-10 DOR-188: Codex disk leak: upstream 0.143.0 adopted, or Codex gated behind a documented flag — decision by Aug 1 · **upstream adopted**: @openai/codex-sdk 0.144.1 (leak fix = openai/codex PR #29599 in 0.143.0), PR #212; SDK JS byte-identical, conformance green
- [x] 2026-07-10 DOR-190 + clean-machine install verified (curl + npx, macOS VM + Linux, Node 22/24) — Jul 19 · DOR-190 fixed in PR #209 (root package rename ended a dual-build race over packages/cli/dist; client/server declared as CLI dev-deps; clean dist-free tree builds green). npx verified in clean Linux containers (DOR-234); macOS-VM curl pass still open if wanted — containers + this Mac cover the practical matrix

### Pillar smoke tests (`09` §2.2, one ticket each; failures pull the claim from launch messaging)

- [x] 2026-07-10 Install + first run, on a machine that isn't the dev machine — Jul 12 · **PASS** (DOR-234; dorkos@0.44.0, clean node:20 + node:22 containers) — but found DOR-245: npm package ships without `core-extensions/`, so the Marketplace tab is missing for every npm install; fix before launch
- [x] 2026-07-10 Schedule a task end-to-end (fires, history, survives restart) — Jul 12 · **FAIL → FIXED same day** (DOR-235; DOR-248 + DOR-249 shipped in PR #199 with the end-to-end scenario re-verified: fire → completed → restart → history intact + next fire clean). DOR-242 (PR #198), DOR-245 (PR #200), DOR-250 (PR #201) also fixed same day; DOR-256 (packaged-CLI extension compile) fixed 2026-07-11 in PR #208 (esbuild promoted to runtime dep + external in the bundle; post-install-check now verifies compilation)
- [~] Telegram notification end-to-end (bind → notify → reply routes) — Jul 12 · **code side complete; BLOCKED only on founder phone legs** (bot token + ~10-min checklist on DOR-236). Since first run: DOR-240 shipped auto notify-on-task-completion (PR #223, one-toggle), DOR-239 enforced canInitiate (PR #219), DOR-277 closed the relay_send consent bypass (PR #227). Reply routing + approval buttons already verified
- [~] Tunnel / mobile (QR → phone cockpit → approve from phone) — Jul 12 · **code blocker cleared; BLOCKED only on founder ngrok token + phone** (DOR-237). DOR-242 fixed (PR #198: fresh-install sign-in works), DOR-244 fixed (PR #214: honest setup copy). Exposure guard + session gate verified correct
- [x] 2026-07-10 Runtime switching x3 + restart persistence — Jul 12 · **FAIL → re-run PASS 2026-07-11** (DOR-238 Done). All four regressions fixed and re-verified: DOR-189 (PR #202 durable event store), DOR-250 (PR #201 CLAUDE_CONFIG_DIR), DOR-251 (PR #216 stable opencode ids), DOR-202 (PR #215 no ghost sessions). Same ids + real transcripts survive restart on all three runtimes; codex turn-completion needs `codex login` on this machine (stale personal OAuth, not a product bug)
- [ ] Obsidian plugin clean-vault test → **(GATE) Week-2 Path A/B decision recorded** — Jul 19 · _test run 2026-07-11 (DOR-269, live CDP-driven Obsidian 1.12.7): plugin failed to load (DOR-270 createRequire polyfill crash) + DOR-271 wrong ClaudeCodeRuntime args for 3 months. Both **fixed and merged** (PR #222, live CDP load proof: plugin mounts, no cache pollution). **Preliminary Path B stands only until the founder's 10-min hands-on on the fixed build** (checklist on DOR-269, test vault at ~/dorkos-obsidian-smoke-vault) records the final decision — FOUNDER ACTION_
- [x] 2026-07-11 Multi-agent Mesh+Relay coordination smoke test — Jul 19 · **PASS after fix** (DOR-259): registration, real A→B delivery, truthful topology passed first run; budget enforcement failed (DOR-260: paid adapter dispatch skipped the gate) and was fixed same day in PR #210 with the exact repro re-verified live (budget 0 → zero turn activity). Per `09` §2.0 coordination stays a Script-3 story, not a launch claim; maxCallsPerHour enforcement deferred honestly as DOR-265
- [x] 2026-07-11 Marketplace superset: 3-5 real Claude Code plugins install + work — Jul 19 · **FAIL → PASS same day** (DOR-258): first run 0/5 end-to-end; root causes fixed in PR #213 (DOR-264 harness scanner ignored CC-native plugins, DOR-261 reserved-name blocked the official marketplace's 255 packages, DOR-263 validator stricter than Claude Code itself) and re-verified on anthropics/claude-plugins-public: 4/4 install + project real files incl. hookify. "Your Claude Code plugins already work here" is now supportable
- [ ] OpenCode local model: fully offline session (RTX 5090 rig) — Jul 26
- [ ] Vault deployment: hardened template passes secure-defaults test — Jul 26
- [x] 2026-07-11 Triage the 41 un-triaged Linear issues — Jul 12 · 67 issues triaged, Triage column emptied: 28 launch-critical → Todo (the fix queue, largely burned down same day), 36 → Backlog, 2 already-fixed → Done, 0 deleted

### Papercuts (`09` §2.3)

- [x] 2026-07-11 DOR-99 usage status item — Jul 19 · PR #211: usage now fetched from the SDK at every turn end; utilization/window/reset render truthfully; API-key sessions stay cost-only
- [ ] DOR-75 identical sidebar titles — Jul 19 · _assessed 2026-07-11: not a papercut — real fix needs a title-generation/divergence design across runtime-owned stores; analysis on the issue, stays Backlog_
- [x] 2026-07-11 DOR-122 dead marketplace toggle — Jul 26 · interim honest fix shipped in PR #211 (canDisable:false renders the Required lock; stale disabled entries self-heal); make-it-a-real-extension refactor stays Backlog
- [ ] DOR-110 operation_progress standardization — Aug 2
- [x] 2026-07-11 DOR-164 status-strip fix + DOR-168 Vitest CVE unification — Jul 26 · DOR-164 verified + CSS cleanup in PR #214; DOR-168 in PR #217 (19 installs unified on vitest 4.1.10, ~230 mock migrations): `pnpm audit` criticals 2 → 0

### Instrumentation (`09` Part 3)

- [x] 2026-07-11 PostHog events + funnels + UTM discipline (site) — Jul 12 · PR #221 (DOR-268): typed funnel events ($pageview → hero_install_copy, docs_visit, marketplace_browse, github_click, newsletter_signup), UTM first-touch verified live, outbound GitHub links tagged; also fixed the latent env.ts bug that kept every NEXT_PUBLIC var out of client bundles. **Founder to flip live: add the PostHog key AND re-enable the cookie banner (consent-gated)**
- [x] Resend Broadcasts + email capture surfaces (footer, /newsletter, post-install line) — Jul 19 · already shipped 2026-07-07 in PR #103 (DOR-195: double opt-in with hash-only tokens, enumeration-safe route, one-time CLI tip line); verified 2026-07-11, tracker was stale. RSS-to-email remains open as DOR-198
- [ ] Opt-in telemetry heartbeat + `/telemetry` page (incl. tunnel/multi-instance fields) — Jul 26
- [ ] Opt-in error reporting (Sentry or GlitchTip) — Jul 26
- [ ] OTel spans + debug exporter — Jul 26
- [ ] Weekly metrics-scorecard Task live (agent-run) — Jul 26
- [ ] Feedback rails: in-app "Report an issue" + `dorkos feedback` + issue templates + DorkBot triage (`09` §3.7) — Jul 26

### Security (pre-traction requirement)

- [x] 2026-07-11 Hardening audit (bindings, tunnel auth, MCP key) — Jul 26 · done early, **shipped PR #225** (DOR-272 umbrella, report `research/20260711_security-hardening-audit.md`). 5 fixes inline incl. **Critical**: marketplace git URLs reached `git clone` at preview time (ext:: arbitrary exec) — transport allowlist + path guard + GIT_ALLOW_PROTOCOL, closed at both the `url` and `git-subdir` source forms after a two-round security review. **DOR-277 (relay_send consent bypass) also fixed** — PR #227 moved canInitiate enforcement to the relay delivery layer + hardened the unauth HTTP publish route against `from`-spoofing. Remaining deferred (filed, non-blocking): DOR-278 (unauth MCP tools on localhost, gated by loopback bind), DOR-279/280/281 (marketplace integrity pinning, token credential-ref, auth rate-limit)
- [x] 2026-07-11 SECURITY.md + `/security` page + threat model — Jul 26 · **shipped PR #225** (DOR-274): SECURITY.md (security@dorkos.ai, honest one-person response), docs/self-hosting/threat-model.mdx, /security site page footer-linked
- [x] 2026-07-11 `dorkos doctor`-style self-check — Aug 2 · **shipped PR #225** (DOR-275): read-only checklist (node, dork-home, port, claude CLI, runtime auth, extension compile, login/tunnel sanity), plain output, exits non-zero only on real failure

### Marketing surfaces, wave 1

- [x] 2026-07-09 — GitHub repo description + topics fixed — Jul 8 (description per `06` tactic #1; swapped 4 stack topics for codex/opencode/orchestration/meta-harness at the 20-topic cap)
- [x] 2026-07-11 README overhaul (positioning, 5-min path, honest alpha status) — Jul 19 · positioning PR #156; 5-min path verified + fixed PR #224 (DOR-276): removed the ANTHROPIC_API_KEY footgun that broke Claude-Code-authed users, corrected the cross-project-sessions overclaim, added the alpha-status note + prerequisites; applied to repo + npm READMEs. Live walkthrough: cockpit reachable in seconds
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
