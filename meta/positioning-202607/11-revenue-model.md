# The Revenue Model: From Free Alpha to Paying Crews

> Positioning review deliverable (July 2026). The monetization strategy, tier ladder, and the month-by-month arc from today's unlaunched alpha to first revenue within 3-6 months. Grounded in: spec #268 (accounts-and-auth, whose decisions this doc builds on, not revisits), the shipped-in-review DOR-181/182 device-link + instance-registry work, and a deep OSS-monetization research pass (2026-07-06; sources and price verifications in the research output; aggregator-sourced prices re-verify before public use).

## 1. The model in one paragraph

The MIT core stays whole and free forever; that is the trust anchor, the acquisition engine, and a one-way door we never walk back through (every license rug-pull in OSS history: HashiCorp → OpenTofu, Redis → Valkey, Elastic → OpenSearch, proves relicensing is how you fork your own community). Revenue comes from **DorkOS Cloud**: things that _inherently require our servers or coordinate multiple humans and machines_: remote access without networking skills, push, multi-instance identity, shared fleets, private registries, spend dashboards, and eventually SSO/SCIM/audit. That fence is architecturally honest (you cannot "self-host our relay infrastructure" by accident), community-accepted (the Tailscale/Grafana/n8n line), and already half-built (spec #268's account-first identity + device link are in review right now). Target: first dollars in month 4, $1-3k MRR by month 6.

## 2. Why people pay (the taxonomy, applied)

The research question was never "what features can we gate" but "why does the money move." Five validated reasons, mapped to DorkOS:

| #   | Why they pay                                                          | Evidence anchor                                                                                                                         | DorkOS translation                                                                                                                 |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Someone else is on call** (hosted convenience)                      | Supabase $25/mo, Plausible $9, Ghost $15; self-host "free" hides 5-10 hrs/mo of ops                                                     | Managed remote access (no ngrok, no config), push notifications, brokered relay bridges                                            |
| 2   | **Cross-device / remote reach** (the individual's one true pay-point) | Obsidian Sync $5-10/mo, Raycast Pro ~$8, Omnara Pro $9                                                                                  | Control your fleet from your phone from anywhere; laptop + desktop + VPS as one fleet under one account                            |
| 3   | **Coordinating humans** (the team boundary)                           | Tailscale $8-18/seat (the closest structural analog), Linear $10-16, Cal.com $12-16                                                     | Shared fleet view, shared agents with ACLs, org accounts, private team marketplace                                                 |
| 4   | **Seeing and controlling spend** (the strongest net-new hook)         | FinOps 2026: AI cost management prioritized by 98% of orgs; LangSmith $39/seat; a whole vendor category (Vantage, Finout, CloudZero...) | Per-agent / per-project / per-person token-spend dashboards, budgets, anomaly alerts, from the cockpit that already sees every run |
| 5   | **Risk reduction / compliance** (the CISO's budget)                   | The SSO tax: SAML/SCIM/audit gated at 2-4x base price across the entire industry, and accepted                                          | Enterprise tier: SAML/SCIM via WorkOS, audit export, advanced RBAC, policy                                                         |

Plus a sixth that gates nothing: **patronage** (Obsidian Catalyst, $25 one-time, "a tip jar" with a badge). It converts devoted individuals at zero trust cost and fits the crew-number identity mechanics we already planned.

What individuals will NOT pay for (research-confirmed, and the ICP doc predicted it): the self-hosted core. Feature-gating individuals does not convert and burns trust. Every paid dollar comes from cloud convenience, team coordination, or compliance.

## 3. The fence rules (non-negotiable)

1. **MIT core stays MIT, forever, and whole.** Anything ever shipped free stays free. New paid value is _added_ in the cloud layer, never _clawed back_ from the core.
2. **Gates on features, not headcount** (spec #268 Decision 4; n8n/Grafana norm). Local multi-user stays in the free core.
3. **The paid line = our servers or multi-human coordination.** If it runs entirely on the user's machine, it is free. This is Tailscale's defensibility logic too: the free control-plane usage (accounts, device link, instance list) is cheap to serve; paid tiers carry the real infrastructure costs (brokered traffic, push, storage).
4. **Don't over-tax SSO.** Social login is free, always. Google-Workspace-grade SSO lands in the team tier; the enterprise premium is SAML/SCIM/audit/residency, priced sanely. Priya reads sso.tax.
5. **The 1% rule shapes urgency, not greed.** Redis relicensed under revenue pressure because ~1% of users converted while others monetized their work. We build the paid surface _now_, calmly, so we never face that decision under duress.

## 4. The ladder

### DorkOS OSS: free forever

Everything that exists today and everything in the Tier-A hardening plan: the cockpit, all three runtimes, Tasks, Relay with self-configured adapters, Mesh, marketplace, self-managed tunnel, MCP, all surfaces. Single operator, full power, offline-capable. _Job: be the best free thing in the category; win the comparison table; feed everything below._

### Founding Crew (patronage, one-time ~$29, at launch)

Gates nothing. Buys: permanent founding-crew badge + low crew number flair, name in the credits, the founders' Discord channel, and the locked founding discount on Cloud tiers when they ship. _Why it exists: immediate non-dilutive trickle, a countable early-believer cohort, and the luxury-codes rarity lever made honest (scarcity of moments and artifacts, never software)._

### DorkOS Cloud: Solo (~$8/mo; founding price locked lower for life)

The individual's tier, priced in the validated $8-10 band (Omnara $9, Obsidian Sync, Raycast, Tailscale personal→paid), deliberately below the $20+ model subscription it augments.

- **Reach:** managed remote access: your cockpit from any device, no ngrok account, no port math, brokered through DorkOS Cloud with the device-link flow already built (DOR-181/182).
- **Push:** real mobile notifications (beyond Telegram) routed through the cloud.
- **One fleet:** every machine you run DorkOS on (laptop, desktop, VPS), linked to one account, one aggregate fleet view, per-instance revocation (the Tailscale dashboard pattern; the instance registry is the shipped foundation).
- **Continuity:** off-site encrypted backup of config/skills/agent manifests (not code, not transcripts by default: privacy posture preserved).

_Why they pay: reasons 1+2. The self-hosted path to all of this remains possible and documented (your own tunnel, your own bot): paying is buying "I don't want to think about it."_

### DorkOS Cloud: Crew (~$15/seat/mo)

The team tier, priced in the Tailscale-Standard-to-Linear band, for the 1-10 person AI-native shop (the ICP).

- **Org accounts** (Better Auth organization plugin, per spec #268's designed-for attach point) with roles.
- **Shared fleet:** the whole team's agents, across everyone's machines, one view: who's running what, what needs a human, what shipped overnight.
- **Shared agents:** task a teammate's agent (or a team VPS agent) with access control. The primitives already exist and were built for exactly this: Mesh access rules authored per agent, enforced by Relay, budget envelopes preventing runaway loops. The paid feature is the cloud-brokered, org-scoped composition of them.
- **Private registries:** the team's own marketplace (skills, agents, rules) with scoped installs; the superset format means these registries also serve the team's plain Claude Code users, which makes DorkOS the team's capability-distribution layer even before full adoption.
- **Team spend:** the FinOps surface: per-agent/per-project/per-person cost dashboards, budgets, anomaly alerts ("Scout burned 4x its normal spend last night"). Reason 4 is the strongest net-new hook in the research and no model vendor offers it cross-vendor. The cockpit already sees every run; this is aggregation plus opinionated presentation.
- **Team SSO:** Google Workspace / OIDC login included (rule 4).

_Why they pay: reasons 3+4. The seat anchor works: a team already paying $25/seat for Claude pays $15 to coordinate, see, and govern all of it._

### DorkOS Enterprise (custom; anchor 2-3x Crew)

Not this quarter, designed-for now: SAML/SCIM via WorkOS (one WorkOS Org per customer, ~$125/connection/mo cost basis maps cleanly to pricing), audit log export/SIEM, advanced RBAC and policy templates, support SLA, and eventually a self-hosted control plane for the truly airgapped. _Why they pay: reason 5. Trigger to build it: the first real inbound with a security questionnaire, not before._

### Explicitly not in the model (this phase)

Hosted DorkOS instances (running agents on our compute: capital-intensive, competes with first parties head-on; spec #268 keeps it possible later). Paid marketplace rev-share (needs volume; revisit post-PMF). Ads, sponsorships in-product: never.

## 5. "Shared drives / shared agents": the evaluation

**Shared agents: yes, it is the team tier's centerpiece.** It is differentiated (nobody else has cross-machine agent ACLs), architecturally prepared (Mesh + Relay were designed as exactly this), and it _is_ the coordination thesis productized. The demo writes itself: "ask the team's release agent to cut a build, from your laptop, with your identity attached."

**Shared drives (literal file storage): no.** Undifferentiated against Git/Drive/Dropbox, a storage-cost liability that breaks the cheap-control-plane economics (rule 3), and a privacy-posture risk. What people actually want from "shared drives" decomposes into things we already do better: shared _capability_ (private registries), shared _visibility_ (fleet view + run history), shared _access_ (agent ACLs). **The adjacent yes:** team knowledge as versioned marketplace packages (rules/skills/context bundles) — "shared team memory" delivered through the registry we already have, not through a filesystem we'd have to babysit.

## 6. The narrative arc (today → month 6)

The revenue arc runs _behind_ the GTM plan's launch arc (`09-gtm-plan.md`), never ahead of it: monetizing before the free product has believers converts nobody and taints the launch. Phases gate on signals, not dates; dates are targets.

**R0: Foundations during launch (months 0-2, = GTM weeks 1-9).**
Ship the free launch exactly per the GTM plan. Revenue-specific additions: GitHub Sponsors live from day one (transitional CTA, patronage trickle); verify-then-park DOR-181/182 (they graduate from "deferred Cloud work" to _the revenue foundation, resumed on schedule in R1_); instrument the two leading indicators (tunnel usage and multi-instance installs via the opt-in heartbeat; team-interest asks via Discord/issues). Publish the **pricing philosophy page** early ("what will always be free, what will cost money and why"): pre-announcing the fence is the single best rug-pull-anxiety vaccine, and it converts the honesty pillar into a monetization asset.

**R1: Free cloud accounts (month 3).**
Ship Cloud identity GA as a _free_ tier: account at dorkos.ai, device link, instance registry, crew numbers. Announce Solo's coming features and price honestly ("remote access without the config: ~$8/mo when it ships; free while in beta; founding crew locks X% off for life"). Founding Crew patronage SKU opens. Gate to proceed: launch retention holding (per GTM §1.1 floors) and ≥ some hundreds of cloud accounts.

**R2: Solo GA: first revenue (month 4).**
Managed remote access + push + multi-instance fleet view exit beta; billing goes live (Stripe; billing was explicitly out of spec #268's scope, so it needs its own small spec). Founding-member pricing honored. Target: first paying users; success is measured in conviction, not volume: 50-150 paying Solos by end of month 5 is the good case.

**R3: Crew design partners (month 5).**
5-10 teams hand-picked from the community run the Crew beta free as design partners: org accounts, shared fleet, shared agents v1, private registry MVP, spend dashboard v1. Their workflows and quotes become the Crew launch material. Gate: Sean Ellis PMF signal from GTM week 10-12 at or above threshold among _individual_ actives first; teams built on unretained individuals churn.

**R4: Crew GA (month 6).**
Crew ships at ~$15/seat with design-partner proof. Enterprise remains conversations-only; WorkOS gets wired when the first contract justifies it. End-of-arc success bands: **floor** $1k MRR, **good** $3-5k MRR, **exceptional** $10k+ (bootstrapped, solo, six months from a 5-star repo: these are honest numbers, and floor-missing means re-examining the tier design against what users actually asked to pay for, not pushing harder).

### The build list this implies (in order)

| When | Build                                                                                                                                                                                                                                                           | Notes                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| R0   | Sponsors, pricing-philosophy page, heartbeat fields for tunnel/multi-instance                                                                                                                                                                                   | Days                                                                   |
| R1   | Cloud accounts GA polish, /activate hardening, crew numbers, founding SKU (Stripe one-time)                                                                                                                                                                     | DOR-181/182 are the bones; weeks                                       |
| R2   | **The relay/broker service** (the big one: managed remote access; spec #268 §7 flagged the site-vs-runtime-service decision, and brokering traffic settles it: it needs a runtime service), push notifications, multi-instance fleet view, subscription billing | The quarter's main engineering investment                              |
| R3   | Org plugin, shared-agent ACL composition (Mesh rules + Relay envelopes, org-scoped), private registries (marketplace scoped-sources extension), spend dashboards (cost line + aggregation + alerts)                                                             | Compositions of shipped primitives, which is why this is feasible solo |
| R4   | Billing for seats, Crew onboarding, audit-log groundwork                                                                                                                                                                                                        | Enterprise pieces only on real demand                                  |

## 6.5 Partnerships: Vault Cloud / Compute Village (added 2026-07-06)

Facts (from vaultcloud.ai and the AI Lab announcement, corrected by founder 2026-07-06): Compute Village is a Texas AI data-center company operating **Vault Cloud** (private AI on dedicated hardware: Vault Gold bare-metal GPU $10K + $599/mo; Workspace $10K + $999/mo with chat/agents; flat-rate, no per-token). Vault Cloud is **unfunded and pre-revenue**. The announced partnership: an "AI Lab" spanning Compute Village + DorkOS + Vault Cloud, an RTX 5090 donated to the DorkOS project. The blog's "Dorian as VP of Product, Agents" is **symbolic**: no formal role, no paperwork, no compensation, and minimal founder time committed. Users can host DorkOS on Vault VPS/hardware or use Vault as an inference endpoint (an OpenRouter alternative) from local machines. Net classification: a friendly ecosystem partnership with a donated test rig, not a strategic commitment; priority accordingly.

### Why this fits (cleanly)

- **Lane separation is exact.** DorkOS is the coordination layer and deliberately does not sell compute (§4: hosted instances excluded). Vault sells compute and does not have a coordination layer. Vault-hosted DorkOS + DorkOS Cloud coordination is a _bundle_, not a conflict: they run the box, we run the fleet.
- **It fills the "hosted" hole without us building it.** The OpenClaw ecosystem showed hosting partners (OneClaw, Hostinger) do real marketing for the OSS project. "Run DorkOS on Vault" answers the always-on/Mac-sleep pain for users who will never manage a VPS, at zero engineering cost to us.
- **Flat-rate private inference is a genuinely good story for agent fleets.** Fleets burn tokens; flat-rate removes meter anxiety, and it plugs into OpenCode's provider-agnostic support as _one more endpoint_, which strengthens rather than strains vendor neutrality. Pairing: our spend dashboards show the burn; their flat rate caps it.
- **A possible vertical channel, someday.** Vault aims at legal/finance/healthcare SMBs (not HN readers), but with no revenue or customers yet the channel value is zero today; treat any referral flow as upside, not plan. Revisit if they land real customers.
- **The 5090 is the local-model test rig**: it directly serves the OpenCode local-model verification and the "Offline" demo clip. This is the partnership's most concrete near-term value.

### Partner posture (the rules)

1. **Non-exclusive, always.** Vault is _a_ deployment partner and _an_ inference option, never _the_. Vendor neutrality is the moat and it extends to infrastructure: docs list Vault alongside "your own hardware, any VPS, other providers." No Vault default anywhere in the product.
2. **The demo-claim gate applies to partners.** No co-marketing until a hardened, DorkOS-authored deployment template for Vault passes the same smoke tests as everything else, including a security baseline (localhost-default, auth-on-exposure). A partner-hosted breach with our name on it is the OpenClaw scenario by proxy; the reference deployment must be ours.
3. **Their claims are theirs.** Vault sells into compliance-heavy verticals while still maturing; DorkOS co-signs only what we verify. Trademark-use guidance (name/logo, "runs DorkOS" vs "powered by DorkOS") should be written down once, lightly.
4. **Measure it.** Vault-referred installs get a UTM/heartbeat source tag like every other channel; the partnership earns calendar space by the same rules as any tactic.
5. **Titles must be true.** The symbolic "VP of Product" title should be softened or dropped from Vault's public materials before they leave staging: DorkOS's honesty pillar extends to claims made _about_ its founder, and a public executive title at an inference/hosting vendor muddies the vendor-neutrality position that is DorkOS's moat. If Vault ever formalizes a real role, re-run this section's analysis (a prior version of this doc treated the role as real and flagged founder bandwidth as the top risk; that analysis is retired, not deleted from git history).

## 7. Risks

- **The free tier is the product for 99%.** Correct and intended (the 1% rule); the plan's economics work at tiny conversion because costs are near-zero and the founder is the payroll. The danger is only ever _resenting_ the 99%: they are the distribution.
- **Cloud service = ops burden on a solo founder.** Mitigation: the control plane is deliberately lightweight (Tailscale's argument); the heavy path (brokered traffic) is exactly what's paid; agents run the on-call runbooks (dogfood).
- **First parties bundle remote access for their own agents.** Already happening (Claude Code web). The counter is the same as the whole thesis: they will never do it _cross-vendor_, and Solo's value is the fleet, not one agent.
- **ToS boundaries:** DorkOS accounts never touch Anthropic/OpenAI auth (spec #268 pre-reading; the delegate-to-host rule stands). Spend dashboards read local run data, never provider account APIs, unless a user explicitly connects billing exports.
- **Trust tax of announcing money during an alpha.** Mitigated by sequencing (R1 announces _after_ launch goodwill exists) and the pricing-philosophy page (the fence in writing, before the first invoice).
- **Founder bandwidth vs the Vault role (the biggest new risk, 2026-07-06).** This whole plan assumes the founder is DorkOS's payroll and full-time engine for 14+ weeks; a VP of Product role shipping a Vault product line in Fall 2026 lands exactly on phases R2-R4. Unmanaged, one of the two roadmaps starves. Mitigations, in order: (1) make the Vault product line DorkOS-based so the day job _is_ the roadmap (§6.5 rule 5); (2) let agents carry more of the GTM's mechanical load (the pipelines were designed for this); (3) if neither holds, the honest fallback is stretching the revenue arc (R4 slips a month) rather than thinning the launch: the launch is unrepeatable, the arc is not. This needs an explicit decision about weekly hours before Week 1 of the GTM plan starts.

## 8. Changes this makes elsewhere

- `09-gtm-plan.md`: Part 4 gains the months 4-6 revenue arc pointer; the "Cloud identity parked" deferral is amended to "parked through launch, resumes in R1 as the revenue foundation."
- `05-marketing-strategy.md` §5 (monetization posture): superseded by this doc; updated to point here.
- `02-positioning.md`: unchanged. The positioning is the free product's; Cloud inherits it ("your fleet, from anywhere" is still coordination).
- ICP (`personas/icp-ai-native-dev-shop.md`): revenue-signals section now has a validated direction; updated pointer.
- The pricing-philosophy page joins `07-website-changes.md`'s additions when R0 begins.
