# Positioning: If We Started From Scratch Today

> Positioning review deliverable (July 2026). Builds on `01-market-landscape.md`. This is the recommendation layer: what to claim, for whom, against what, and the few product moves that multiply everything else.

## 1. What changed since the Q1 positioning was written

The Q1 meta docs positioned DorkOS as "the operating system for autonomous AI agents" with Claude Code as the first runtime and autonomy (overnight execution) as the hero benefit. Three things changed:

1. **The product**: multi-runtime is real now. Claude Code, Codex, and OpenCode all work, per-session, behind one conformance-tested interface. In Q1 this was an architecture claim; in July it is a demoable fact none of the peer group can match.
2. **The market**: Anthropic shipped the things the Q1 villain was built on. Remote access, async cloud execution, managed multi-agent orchestration, scheduled memory curation. "Your agent stops when you close the laptop" is being solved by the vendor, for their vendor. The pain that remains unsolved by first parties is _coordination across_ vendors, projects, and surfaces, under your control.
3. **The category**: "meta-harness" got named, populated, and had its first security crisis. Buyers now compare; they no longer need convincing that orchestration is a thing.

The core thesis survives fully intact ("intelligence doesn't scale; coordination does"). The _entry point_ needs to move.

## 2. The from-scratch positioning

### Category

**The self-hosted control plane for your AI agent fleet.** (Internal shorthand; in public copy, stay human: "mission control for your agents.") We enter the conversation through the meta-harness category because that is where buyers are looking, then win it on depth: a meta-harness is a dashboard; DorkOS is the coordination layer under one.

### Positioning statement

> DorkOS is mission control for every coding agent you run. Claude Code, Codex, OpenCode: one cockpit, any device. Schedule them, let them message you and each other, and keep everything on your machine. Open source, MIT.

### The three claims, in order

1. **Vendor-neutral, structurally.** Any agent, per session, one interface. The claim no first party can ever make, and the answer to "what happens when Anthropic ships this?" (They did ship it. For their agent. That is the point.)
2. **A coordination layer, not a dashboard.** Scheduling, messaging (to you and between agents), discovery, memory, marketplace. The peer group shows sessions; DorkOS runs an organization.
3. **Yours.** Self-hosted, laptop-first, MIT, honest about what goes to model providers. Post-OpenClaw, pair this with _secure by default_ or "self-hosted" reads as a liability instead of a benefit.

### The one-sentence word-of-mouth test (Godin format)

"You know how you've got Claude Code in one terminal, Codex in another, and no idea what any of them did overnight? Someone built mission control for that."

### What stays

- **Thesis line**: "Intelligence doesn't scale. Coordination does." The market spent a year proving it — but it is no longer the roof _(amended 2026-07-09)_: it's a mechanism claim, and the roof now belongs to the customer ("**You, multiplied.**", see §5). The thesis stays as the **manifesto line** — essays, litepaper, anti-positioning/comparison surfaces, and the launch-thread defense (agents changed Brooks's coordination-cost curve). Demoted, not deleted.
- **Identity close**: ~~"Built by dorks. For dorks. Run by you."~~ _Superseded 2026-07-09 (founder decision, extending the hero reframe):_ the customer is the hero and is never labeled — new close: **"We built it for ourselves. Now it's yours."** The filter lives in the product NAME, not in badging the reader; "dork" stays as the maker's mark. Signature changes from "Dorkian" to "— Dorian".
- **Anti-persona discipline**: no hosted no-code anything.
- **Pro-human framing** (Decision 16): agents multiply what you accomplish; the human is the point.

### What moves

- **Autonomy demotes from hero to proof.** "You slept. They shipped." becomes evidence inside the story, not the door. The door is now _control of a fleet you already have_. (Most target users in mid-2026 already run 2+ agents; their felt pain is chaos and vendor sprawl more than idle nights, and first parties are actively solving idle nights.)
- **"OS for agents" becomes the vision line, not the category entry.** It is the right ambition and the right architecture story for Priya, but as a category label it invites "isn't that OpenClaw/Omnigent?" Enter as mission control, expand to OS.
- **Single-runtime language dies everywhere.** The GitHub description ("...for Claude Code"), the FAQ, the OG image. Every surface says the three runtimes or says nothing about vendors.

## 3. Who, exactly (niches ranked)

1. **The multi-agent Claude Code power user** (Kai, unchanged but sharpened): already runs several sessions daily across projects, feels the 15-tab chaos _today_. Found in r/ClaudeAI, HN Show threads, X build-in-public circles. Beachhead: highest pain, fastest word-of-mouth.
2. **The vendor hedger** (new, growing fast): runs Claude for quality and Codex for cheap bulk work, hates having two workflows. Multi-runtime cockpit is a purchase trigger by itself. Found in the same places plus Codex-adjacent communities.
3. **The Obsidian knowledge-worker dev** (Priya): completely unserved (no peer product has an Obsidian surface), reachable through one concentrated channel (Obsidian plugin directory + community), and the plugin already exists. Small niche, outsized loyalty and content energy.
4. **The AI-native dev shop (1-10 people)**: the existing ICP; adopts after individuals bring it in. Do not sell to them directly yet; make individual adoption excellent.

_(2026-07-09: two grounded personas joined the set — Ikechi, the non-developer AI-native founder (secondary), and Lil, the private professional (horizon, staged). **Neither changes this ranking or the launch targeting.** They raise the product bar — plain-language errors, recovery paths, privacy defaults, the desktop surface — and mark the post-beachhead expansion path. See `../personas/` and the redrawn anti-persona boundary: operator mentality, not technical skill.)_

## 4. The few product moves that change the game

Ordered by leverage per unit of work:

1. **The 5-minute magic path, engineered as one flow** (highest leverage, mostly polish not features): install → cockpit shows every existing Claude Code session already there (instant "it knows me" moment, already true) → schedule one task → connect Telegram → get pinged. Every element ships today; the work is making the sequence frictionless and the default onboarding. This is the demo, the launch video, and the retention hook in one.
2. **Cost/model-aware task routing** (the "kernel scheduler" move): let a Task or agent declare what it needs ("cheap+fast" vs "best reasoning") and have DorkOS pick the runtime. Uniquely enabled by the runtime abstraction; instantly legible ("it sends bulk work to Codex and hard problems to Claude"); makes vendor-neutrality _do_ something instead of just _being_ something. Even a v1 (per-task runtime + model presets, a cost line in run history) is a category-first.
3. **A fleet home screen** (the "org chart" view): one screen that answers "what are all my agents doing right now, what do they need from me, what did they finish?" across runtimes and projects. The Mesh topology graph is adjacent but network-shaped; this is status-shaped. It is the screenshot that sells the product and the tab people keep open all day. (The peer group's entire existence, Conductor/Vibe Kanban, is a weaker version of this one screen.)
4. **Security posture as a feature** (cheap, urgent): secure-by-default bindings, passcode/tunnel review, a published threat model page, a `dorkos doctor --security` check. Turns the category's open wound into a differentiator. Must precede any traction push, because traction is exactly what makes you a target.

Explicitly _not_ now: hosted SaaS, team/multi-user features, Wing as a product, new runtime adapters beyond the three (breadth later; depth now).

## 5. Message house (v2 draft)

**Roof** _(amended 2026-07-09)_: **You, multiplied.** — one person, shipping like a team. The customer is the subject of the roof (StoryBrand discipline, §8.1, applied to the tagline itself). The coordination thesis demotes to manifesto line: it names the mechanism, so it leads the anti-positioning/comparison register and the essays, never the hero. Supporting argument when defending the reframe: model intelligence is abundant and vendor-sold; the customer's judgment is the scarce input; DorkOS scales _them_.

**Pillar 1: One cockpit, any agent.** Claude Code, Codex, OpenCode. Per-session choice, one interface, every device (browser, desktop, Obsidian, phone). _Proof:_ live runtime switcher; sessions from the CLI appearing instantly; conformance suite in CI.

**Pillar 2: A team, not tabs.** Schedules, messages, discovery. Agents that ping your phone when they finish and find each other when they need help. _Proof:_ the 5-minute path; a night-run receipt (real PR, real Telegram screenshot); Relay/Mesh docs.

**Pillar 3: Yours, and safe to run.** Self-hosted, MIT, laptop-first, secure by default, honest about what goes to model providers. Includes fully-local sessions: OpenCode brings local models, so private work provably never leaves the machine. _Proof:_ threat model page; localhost-default config; an offline-session demo; the honesty section; readable source.

**Foundation:** built by one dork with an agent fleet, in public, dogfooding all of it.

## 6. The ecosystem judo (added 2026-07-06)

Three shipped facts compose into the positioning's quiet superweapon:

1. **Marketplace superset**: DorkOS's marketplace format is a strict superset of Anthropic's Claude Code plugin-marketplace format. Everything built for Claude Code installs into DorkOS; DorkOS marketplaces serve plain Claude Code users too. We launch with the largest agent-plugin ecosystem in the world already on our shelf.
2. **Harness sync**: whatever you install projects to every harness on your machine (Cursor, Copilot, the CLIs). DorkOS is not a silo; adopting it upgrades tools you already use, which removes the switching-cost objection entirely.
3. **Tasks are skills with metadata**: any skill, including one installed sixty seconds ago, can be scheduled as an autonomous job.

Chained: **install any Claude Code plugin → it works in everything you use → it can run itself on a schedule.** Capability becomes automation in three clicks. The strategic analogy is Kubernetes and Docker: don't fight the ecosystem, orchestrate it and inherit it. First parties can't copy the neutral half (syncing to competitors' harnesses); peers don't have the marketplace or the scheduler to compose.

Presentation rule: this is nerdy, so it is _shown_, never explained. One 20-second demo (install a real Claude Code plugin → it appears in Cursor → schedule it nightly) says what three paragraphs can't. On the site it becomes a compatibility section ("Your plugins already work here"); at launch it is one thread beat; the full essay waits for Week 10 (`09-gtm-plan.md`). Verification gate first: prove the superset claim against 3-5 popular real-world Claude Code plugins before any public claim (GTM pillar matrix).

## 7. Naming note (flag, not a recommendation)

"DorkOS" is a strong tribe filter and is already earning provenance; keep it. One caution surfaced by research: as security scrutiny of self-hosted agents grows, press coverage will lowercase-compare "openclaw, dorkos" as a class. The security-posture work in section 4 is what prevents guilt by association; the name itself is fine.

## 8. Narrative frames: StoryBrand and luxury codes (added 2026-07-06)

Two frameworks pressure-tested against this positioning; both survive with adaptations.

### 8.1 StoryBrand: the user is the hero, DorkOS is the guide

The Decision-16 pro-human shift already did most of StoryBrand's work: the builder is the creative force, agents multiply what they accomplish, the villain is a missing layer rather than a person. The full mapping, now made explicit so copy stays disciplined:

- **Hero:** the builder. **External problem:** agents siloed by vendor, idle by default, chaotic in tabs. **Internal problem (sell this one):** "I have more ideas than hours, and I've somehow become the integration layer between my own tools." **Philosophical:** builders deserve tools they own.
- **Guide:** DorkOS, and Dorian behind it. Empathy first ("I ran ten agents across five projects and lost my mind"), authority second (built-at-scale track record, 1,244 commits, the dogfood receipts). The founder story is _guide credentials_, never the hero's tale: it appears as "I built this because I needed it," not "look what I built."
- **The Plan (three steps, stated as three steps everywhere):** 1. Install. 2. Meet your fleet (your sessions appear; name your first agent; connect Telegram). 3. Hand off the night. The site's install section, the README quickstart, and the FTUE should all present these same three beats with the same names.
- **CTA:** direct = Install. Transitional = the newsletter/fleet reports and starring the repo.
- **Stakes (kept gentle per pro-human rules):** mornings lost to firefighting, work finished at 11pm that nobody hears about. Never "you're falling behind."
- **Transformation (the line copy should earn):** from running sessions to **running an organization**. "You stop operating terminals. You start directing a team."

Voice guardrail derived from this: in every asset, count the sentences whose subject is "you/your fleet" vs "DorkOS/we." The former should win. DorkOS brags only through what the user's fleet did.

### 8.2 Luxury codes: adopt the codes, refuse the economics

The Luxury Strategy's _economics_ (raise prices, restrict supply, never meet demand) are wrong for an MIT-licensed alpha that needs a star loop. But its _codes_ map startlingly well onto choices the brand already made, and naming them keeps us consistent:

- **Selectivity over pandering:** the name-as-filter, the anti-persona, "not built for casual users": DorkOS already "dominates the client" in Kapferer's sense. Keep refusing no-code, hosted, and dumbing-down requests; every public refusal raises the tribe's identity value.
- **Provenance and the maker's hand:** luxury sells the atelier. Ours is real: one builder and their agent fleet, decisions documented in public, a signed identity close. Play it up in the about/why page and release notes; it cannot be copied by a committee.
- **Craft as the premium signal:** for a free tool, "premium" is earned through detail: the cream aesthetic, restrained delight (`10-delight-and-hooks.md`), opinionated defaults, error messages written like documentation. Linear and Superhuman proved devs experience polish as luxury; that is the brand's existing quality bar with a name on it.
- **Rarity where it is honest:** beta _seats_, crew numbers (#214 of a growing crew), once-ever first-blood moments, numbered/limited launch stickers. Scarcity of artifacts and moments, never of the software.
- **No comparisons on brand surfaces:** luxury is superlative, never comparative. Resolution with the GTM's comparison pages: the _homepage and hero assets_ never mention competitors (self-referential confidence only); comparisons live in docs/SEO surfaces where developers demand them. Two registers, one brand.
- **The luxury test for copy:** would this sentence still work if we charged $200/month? If yes, ship it free: that is the feel we want. ("Alpha" is compatible with this: luxury houses show unfinished ateliers proudly; what they never show is carelessness.)
