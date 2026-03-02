# FTUE Best Practices Deep Dive: Becoming an Expert in First Time User Experience for Developer Tools

**Research Date:** 2026-03-01
**Research Mode:** Deep Research (15 tool calls, 5 structured rounds)
**Subject:** World-class FTUE for DorkOS — an OS-layer for AI agents
**Target Personas:** Kai (Autonomous Builder), Priya (Knowledge Architect), Anti-persona: Jordan (Prompt Dabbler)

---

## Research Summary

The best first-time user experiences for developer tools share a counterintuitive quality: they don't look like onboarding. They look like the product working. The most respected tools in this space (Linear, Arc, Vercel, Stripe) achieve their FTUE excellence not through tours, checklists, or walkthroughs, but through three compounding principles: **radical respect for user intent**, **progressive disclosure as the product's default behavior**, and **empty states that are genuinely useful rather than decorative**. For DorkOS specifically, the FTUE challenge is unique — a CLI-first, multi-module, self-hosted tool with expert-only target personas who have explicitly rejected the "chatbot wrapper" category. The research synthesizes into a concrete FTUE framework across five rounds.

---

## Round 1: Foundations — What Makes a Great FTUE?

### 1.1 The Theoretical Bedrock

Three behavioral frameworks underpin nearly all best-in-class FTUE design. Understanding all three is necessary before making any concrete decisions.

#### BJ Fogg's Behavior Model (B = MAP)

Stanford researcher BJ Fogg's model defines behavior as the intersection of three simultaneous conditions: **Motivation**, **Ability**, and a **Prompt**. For behavior to occur, all three must converge at the same moment.

The model's most important design implication: **increasing Ability (making something easier) is almost always more effective than increasing Motivation (trying to persuade)**. This directly challenges the impulse to use marketing copy, social proof, or product tours to nudge new users — if they're motivated enough to install your tool, the problem is almost never motivation. It's friction.

For DorkOS, Kai already has maximum motivation. He installed `dorkos` because he wants his agents to work while he sleeps. Every obstacle between `npm install -g dorkos` and the first agent session running is a Fogg Model failure of Ability.

Fogg's "Tiny Habits" extension adds: scale the desired first behavior down to its absolute minimum. The threshold for what counts as "activation" should feel embarrassingly small. Not "run your first scheduled agent job" — just "see a session." Not "configure Relay" — just "recognize that Relay exists and why you'd want it."

#### Nir Eyal's Hook Model

The Hook Model (Trigger → Action → Variable Reward → Investment) is most valuable for DorkOS not as a manipulation framework, but for what it reveals about **the Investment phase**. In developer tools, habit formation accelerates dramatically once a user has invested something: configured their cwd, created their first schedule, named an agent. Stack Overflow's reputation system is the canonical example — once developers have accrued reputation, they return because they've built something they'd lose.

The FTUE's job, through this lens, is to get Kai to make his first meaningful investment as quickly as possible. That investment doesn't need to be elaborate. It just needs to be **his** — something that makes the tool feel personal before he's even used it heavily.

For Priya, the investment may be even more emotionally significant: connecting her Obsidian vault to DorkOS means her thinking environment and her execution environment are linked. That linking moment is the investment. FTUE should engineer a path to that moment.

#### Jobs to Be Done (JTBD) as Onboarding Architecture

The JTBD framework (When [situation] + I want to [motivation] + so that [desired outcome]) is the most structurally useful framework for designing FTUE for DorkOS, because it forces you to center the user's goal rather than the product's feature set.

Kai's job: "When I have agents working on tasks, I want them to operate autonomously overnight so that I can wake up to completed work."

Priya's job: "When I'm doing deep thinking in Obsidian, I want to execute on those ideas using Claude Code so that I don't lose context switching between environments."

**Critical implication:** A JTBD-aligned FTUE does not introduce features. It introduces pathways to jobs. The first question the UI asks (implicitly or explicitly) is not "here's what this tool can do" but "what are you here to do?" — and then it routes accordingly.

### 1.2 Why Product Tours Fail — The Research

The evidence against product tours for developer tools is substantial:

**Dismissal data:** For product tours with 2-6 cards, only 33% of users reach the final card. For tours with 7-11 cards, that number drops by more than half — to roughly 16%. A tool with 4+ modules like DorkOS would need a tour of 10-20+ cards to cover the surface, virtually guaranteeing abandonment.

**The "trapped" feeling:** Forced tours — those that are not skippable or that block interaction until complete — are widely documented as creating frustration. For expert users like Kai, this is catastrophic. A tool that treats him like a beginner before he's done anything wrong has already failed the trust test. His anti-adoption signal is explicit: "If the README was full of marketing language with no technical substance." A product tour is the in-product equivalent of marketing language.

**Generic failure mode:** Product tours treat every user identically. They cannot distinguish between Kai (who knows exactly what he wants and needs zero hand-holding) and a hypothetical new user with no context. The tour that attempts to serve both serves neither.

**Passive learning failure:** Research from multiple sources converges on the finding that passive observation (reading tooltip cards, watching feature demonstrations) does not create the learning retention that active engagement does. Tours show; they do not teach by doing.

**Timing mismatch:** Traditional tours appear immediately upon first login, before the user has developed any context about what they want to accomplish. This is precisely the wrong moment — the user is least equipped to absorb information about features they haven't yet needed.

**The one legitimate case for tours:** User-triggered tours — accessible via a "Show me around" option — outperform blanket triggers by 2-3x. If DorkOS implements any tour-like mechanism, it must be opt-in, always accessible (not only on first run), and targeted (a tour of Pulse, not a tour of "everything").

### 1.3 Progressive Disclosure as FTUE Philosophy

Progressive disclosure, formalized by Jakob Nielsen in 1995, is the practice of deferring advanced or rarely-used features to secondary screens, revealing them contextually as the user develops need. It is not the same as "feature gating" (where features are locked by payment tier) or "wizard-driven onboarding" (where the system forces a sequence).

The key distinction: **progressive disclosure is a permanent design philosophy, not a temporary onboarding state.** It doesn't end after day one. The product's information architecture is structured so that the most essential things are always most visible, and complexity becomes accessible through deliberate navigation rather than accidental encounter.

For multi-module products, progressive disclosure solves the "where do I even start?" problem not by answering it for the user, but by ensuring the entry-level surface is small enough that the user can answer it themselves.

The Nielsen Norman Group's research establishes a practical limit: **designs with more than 2 levels of disclosure nesting have low usability** because users get lost. DorkOS has 4+ modules — this means the top-level view must be clean enough that the 4 modules feel like a flat, scannable list, not a hierarchy of nested features.

Implementation patterns that work:
- **Accordions**: Progressive expansion within a single view (good for settings, configuration)
- **"Show more" / "Show details"** links: The macOS print dialog is the canonical example — minimal by default, full options on demand
- **Contextual tooltips**: Appear when users hover or focus relevant controls — not on page load
- **Secondary screens**: Advanced configuration lives in a separate panel, accessed deliberately

### 1.4 Considerate Interfaces — The Alan Cooper Framework

Jeff Atwood's influential post "Making Considerate Software" (citing Alan Cooper and Robert Reimann's "About Face") articulates 13 principles for what it means for software to be considerate. The most relevant for DorkOS's FTUE:

1. **Takes an Interest**: The tool should remember what the user did last time. If Kai opened a session in `/projects/my-app`, it should default to that next time.

2. **Is Forthcoming**: Beyond answering what was asked, the tool shares related information. When Kai starts a session, show git status. When he sets up a schedule, show the next 3 run times.

3. **Keeps You Informed Without Interruption**: Surface useful status in the periphery — a status bar, a quiet badge — not through modals or alerts.

4. **Is Perceptive**: Remember user preferences automatically. If Kai always uses dark mode, don't ask again. If Priya always opens to the Obsidian panel, start there.

5. **Is Self-Confident**: Avoid excessive confirmation dialogs. Don't ask "Are you sure?" for reversible actions. Don't warn the user before every tool execution.

6. **Doesn't Ask Many Questions**: Present options through interface affordances rather than interrogation. Not "which directory would you like to work in?" as a prompt — but a directory picker that defaults to the sensible choice.

7. **Doesn't Burden You With Its Problems**: Don't surface system errors, loading states, or edge case warnings unless the user needs to act on them. Pulse running at 3am shouldn't ping Kai about its internal state unless something failed.

**The "calm technology" corollary** (from Amber Case's work): Information should move from the periphery of attention to the center only when relevant. DorkOS runs agents in the background — the default state should be calm. Activity should be visible but non-intrusive, like a heartbeat rather than an alarm.

---

## Round 2: Developer Tool FTUE — Best-in-Class Examples

### 2.1 Vercel: Zero-Config as Onboarding

Vercel's developer experience success is documented extensively. Their approach can be summarized as **"the deployment works before you understand how it works."** The FTUE is: push to GitHub, and things deploy. No configuration wizard. No "set up your build settings" dialog. Sensible defaults that work for the common case.

**What Vercel does brilliantly:**
- Zero-config deployments eliminate the "cold start" — users see value before they understand the product
- Starter kits and templates preload the workspace with something meaningful, avoiding blank-slate paralysis
- Every push creates a preview URL — the product proves itself on first use
- Documentation is framed as "getting started" not "learning the system"

**What fails:**
- The web UI is feature-heavy; discovering advanced capabilities requires significant exploration
- Team onboarding is less elegant than individual onboarding

**Transferable to DorkOS:**
- The `dorkos` command starting the server without requiring any configuration is the Vercel equivalent. It must "just work" on first run.
- Pre-populating the session view with something (or at least pointing clearly to how to create something) eliminates the cold start
- A sensible default working directory (inferred from the current `cwd` or configured `DORKOS_DEFAULT_CWD`) removes the first friction point

### 2.2 Stripe: Documentation IS the FTUE

Stripe is the gold standard for developer-first onboarding. Their key insight: **the FTUE for a developer tool is the documentation, not the UI.** Stripe's "Try It!" buttons embedded in docs, pre-filled API keys in code examples, and a consistent time-to-first-API-call focus make the docs themselves the activation mechanism.

For DorkOS, the README and the docs site are the first touchpoint — not the web UI. Kai will read the README before installing. If it contains marketing language, he's gone. If it contains a clear, technically honest description of what DorkOS does and why, followed by an immediately executable code block (`npm install -g dorkos && dorkos`), he stays.

**The "Time to First Call" metric** is Stripe's north-star. For DorkOS, the equivalent is: **time from `npm install -g dorkos` to first visible agent session in the UI.** Every second counts.

**What Stripe does brilliantly:**
- Test mode requires no approval, no production access — immediate value without permissions hurdles
- Code examples are copy-paste runnable
- Error messages include actionable recovery steps (not just what went wrong, but what to do)
- Documentation treats developers as smart people who want to understand, not be guided

**Transferable to DorkOS:**
- The FTUE begins in the README, not in the web UI
- The `dorkos init` wizard (or equivalent) should produce a running system in under 5 minutes, not require configuring env vars manually
- Error messages from the CLI must be diagnostic and actionable, not generic

### 2.3 Linear: Design Coherence Without A/B Testing

Linear's onboarding is studied as a case study in doing more with less. Their flow:

1. Dark/light mode selection **first** — establishes that this tool cares about your preferences before asking for anything
2. Keyboard shortcut tutorial (⌘+K for Command Menu) — teaches the power-user interface before the standard UI
3. Team joining (company email domain, no invite required) — removes friction from expansion
4. GitHub integration explanation — benefit-focused, not feature-focused
5. Clean completion — no confetti, no aggressive "next steps" list

**What makes this exceptional:**

The flow was built without A/B testing — designed end-to-end with a clear mental model of the user, rather than optimized screen-by-screen. This cohesion shows. Each step has a clear reason for existing at that moment.

The keyboard shortcut tutorial is counterintuitive genius. It teaches the *power-user interface* as the entry point, not the basic UI. This signals that Linear is designed for people who want mastery, not people who want simplicity. For Kai, this is exactly right.

The theme selection comes first because it's **low-stakes personalization** — it's easy, it's personal, and it sets a tone of agency before any demands are made. This is Fogg Model insight applied elegantly: start with minimum ability required, maximum user control.

**Transferable to DorkOS:**
- Start with something that makes the tool feel personalized before asking anything of the user (theme, cwd, agent name)
- Teach keyboard shortcuts / command palette early — this signals to power users that they're in the right place
- Frame team/collaboration features through domain-based access (no explicit invite flows initially)

### 2.4 Arc Browser: 90-Second Progressive Feature Introduction

Arc Browser's introduction of its Max AI feature is a model for introducing advanced capabilities in a complex tool:

- **90-second time limit** for the AI onboarding — if it takes longer, it's too complicated
- **Two features only** — not the full AI toolkit. Just search summarization and webpage summarization
- **Hands-on demonstration** — users do the action, not just watch it
- **Real-world transfer** — the gestures practiced during onboarding immediately work in actual browsing
- **Opt-out respected** — revert to traditional search with one click

**What Arc does brilliantly:**
- Time-bounds the feature introduction — creates a mental commitment before showing anything
- Leverages existing behaviors (pinching gestures) rather than inventing new interaction patterns
- Provides immediate escape hatch — trust comes from having an out, not from being locked in

**What fails:**
- Safari users found the vertical tabs and shortcut-key reliance difficult — old habits compete with new paradigms
- Extensions weren't introduced in onboarding, leading to significant features going undiscovered

**Transferable to DorkOS:**
- Each module (Pulse, Relay, Mesh) should have a ~90-second "why this exists" introduction accessible on demand
- Introductions should be interactive (run your first schedule) not explanatory (here's how schedules work)
- Power features of each module should be discoverable within the module, not introduced in the global FTUE

### 2.5 Notion: Solving Blank Canvas Paralysis

Notion's most studied FTUE challenge is the "blank canvas problem" — an infinitely flexible tool with a completely empty starting state is maximally intimidating. Their solution: **template-based workspace preloading**, where new users' workspaces are initialized with example content matching their stated use case.

Research on Notion's approach: users who start with templates show significantly higher retention than those who start from scratch. The templates serve as "training grounds" — users learn what the tool can do by seeing real examples and customizing them rather than reading abstract explanations.

For DorkOS, the blank canvas problem appears in multiple places:
- First open: no sessions, empty sidebar
- Pulse: no schedules, empty schedule list
- Relay: no endpoints, no messages
- Mesh: no agents, empty topology graph

Each of these is a potential abandonment point if not handled with care.

**Transferable to DorkOS:**
- Pre-seed the UI with a demo session or "demo mode" that shows what a populated DorkOS looks like
- Empty states for each module should show a minimal example of what the module does, not just a "create your first X" prompt
- Alternatively: a sample schedule that runs immediately on first activation, so Kai sees the tool working within seconds

### 2.6 Raycast: Extensible Tool Onboarding

Raycast's onboarding handles the "this tool can do anything" complexity by **leading with the two most universal features** (search and window management) and letting everything else be discovered through use and the extension store.

Their walkthrough command structure is notable:
- Users complete tasks and track progress
- Features are demonstrated by using them, not describing them
- The extension store is treated as a feature to discover, not a surface to explain upfront

**Transferable to DorkOS:**
- The extension system (slash commands, `.claude/commands/`) should be discoverable within the UI via Command Palette, not explained in onboarding
- The command palette IS the power-user interface — if Kai finds it, he finds everything

### 2.7 Self-Hosted Tools: Coolify and n8n

Self-hosted tools face a distinct challenge: the user must configure infrastructure before seeing any value. This is where configuration burden becomes critical.

**Coolify's approach:** One-click deployment templates eliminate configuration entirely for common cases. Supabase deploys in 20 minutes. The technical complexity is abstracted until the user specifically needs to customize it.

**n8n's first-run experience:** Optional personalization questions on first setup — not mandatory, not blocking. You can skip them and see the tool immediately. License registration unlocks additional features without blocking basic use.

**Key insight from self-hosted tools:** The "cold start" problem is uniquely severe because there's no hosted sandbox to fall back on. If the self-hosted setup requires 20 decisions before showing value, abandonment is near-certain. DorkOS must minimize configuration decisions before the first working state.

---

## Round 3: FTUE for Multi-Module Products

### 3.1 The Multi-Module Discovery Problem

DorkOS has 4 distinct modules with different purposes:
- **Chat**: Foundation — AI agent interaction
- **Pulse**: Scheduling — autonomous background execution
- **Relay**: Messaging — inter-agent communication
- **Mesh**: Discovery — agent coordination network

These modules exist on a spectrum from "universally needed immediately" (Chat) to "needed only after significant sophistication" (Mesh). The FTUE must establish this spectrum implicitly — not through a diagram explaining the architecture, but through the experience of using the tool.

Research on how successful multi-module products handle discovery:

**Slack's pattern:** New features are introduced with single-step tooltips when users interact with the relevant surface — not in a separate onboarding flow. Features are surfaced contextually (Canvas appears when you're in a channel doing certain things; Huddles appear in the people list). The sidebar is structured so basic features are most prominent.

**Figma's pattern:** The product tour explains the editor thoroughly on first login — but only because the editor IS the product. There's no hiding behind progressive disclosure when everything matters immediately. DorkOS is not Figma — only Chat needs to be immediately accessible.

**Discord's pattern:** Advanced features (server setup, channel configuration, bots) are deferred behind a clear hierarchy. You join a server before you configure one. The default experience is simple because most users never need configuration.

**The right model for DorkOS:** Slack + Discord hybrid. Chat is the entry surface. Pulse, Relay, and Mesh are visible but clearly secondary — tabs or sections in the nav that don't demand immediate attention. Their empty states explain themselves. When Kai is ready to schedule an agent, he knows where to go and why.

### 3.2 Empty States as the Primary FTUE Vehicle

Nielsen Norman Group's research establishes that **well-designed empty states are more memorable and effective than forced tutorials**, because they're encountered naturally as users explore rather than being imposed before exploration begins.

The three functions of a great empty state (from NN/G):

1. **Communicate system status**: Is this empty because nothing exists yet, or because of an error? Make it obvious.
2. **Provide learning cues**: A "pull revelation" — teach the user what they'd find here if they populated it. DataDog's "Star your favorites to list them here" is the example.
3. **Enable direct task pathways**: A single, clear action button that creates the first item.

The design formula: **two parts instruction, one part delight**. The instruction must be completely clear before personality is added.

For DorkOS's modules:

**Chat empty state:** The most important. A new session with a clear "Start a session" prompt and enough context to understand what cwd means. Maybe: "Claude Code is running. Open a session in your project directory." With a directory picker that defaults to the last used or configured cwd.

**Pulse empty state:** "No schedules yet. Schedules let your agents run overnight or on a timer — while you're away." Then: "Create your first schedule" button. Maybe a small example showing what a schedule looks like (interval, prompt, cwd).

**Relay empty state:** "No messages yet. Relay connects your agents so they can communicate and coordinate." This is more abstract — the empty state needs to do more explanatory work. Link to documentation.

**Mesh empty state:** "No agents registered. Mesh makes your agents discoverable to each other across projects." Simple diagram of 2-3 dots connecting. The topology graph IS the empty state (showing what it would look like).

### 3.3 Configuration as Onboarding — Making Config Feel Empowering

Developer tools with configurable infrastructure face a specific problem: the configuration IS the product. Env vars, JSON files, feature flags — these aren't obstacles to value; they're expressions of value. But they're only empowering if the user understands what each option does and why they'd want it.

**The empowering configuration pattern:**
1. Show what works with zero configuration (sensible defaults)
2. Explain what additional configuration unlocks (not what it does technically, but what it enables functionally)
3. Make configuration reversible and low-stakes
4. Confirm what's been configured before moving on

**The burdensome configuration pattern:**
1. Require decisions before showing anything
2. Technical explanations of config fields without functional context
3. No defaults — every field blank
4. Silent failure when config is wrong

For DorkOS, the feature flags (DORKOS_RELAY_ENABLED, DORKOS_MESH_ENABLED, DORKOS_PULSE_ENABLED) are configuration-as-activation. They should be presented not as "environment variables you need to set" but as "features you can unlock."

**Concrete pattern:** When Pulse, Relay, or Mesh tabs are visible but their feature flags are disabled, the empty state should say: "Pulse is available but not enabled. Add `DORKOS_PULSE_ENABLED=true` to your .env to activate it." — with a copy button for the env var. This is progressive disclosure of configuration.

---

## Round 4: Anti-Pattern Deep Dive — Why Experts Hate Being Onboarded

### 4.1 The Expert User Problem

Expert users — and Kai is explicitly expert-level — come to a new tool with a specific mental model of what they're trying to accomplish. When a product tour interrupts them before they've done anything, it creates a specific, named frustration: **the "I already know what I want to do" problem**.

This isn't impatience. It's a signal. The expert user has allocated mental bandwidth to their goal, not to learning your product. Onboarding that requires them to set aside their goal and adopt yours is a cognitive tax that erodes trust.

**What experts actually need in FTUE:**
1. Confirmation that they're in the right place (the product does what they came to do)
2. The fastest possible path to their first meaningful action
3. **Discovery hooks** — affordances that make advanced features findable when they're ready, without demanding engagement before they're ready

**What experts explicitly do not need:**
- Explanation of what the product does (they read the README)
- Feature showcases (they want to use, not observe)
- Confirmation prompts (they made their decision; they installed the tool)
- Progress indicators for the onboarding itself (they didn't come to complete onboarding)

### 4.2 Respecting Intelligence Without Being Unhelpful

The balance is subtle. Expert users don't want to be helped they didn't ask for, but they do appreciate **help they discover at the right moment**. The design challenge is: how do you provide guidance without patronizing?

**The "pull" model vs. the "push" model:**
- **Push**: Onboarding delivers information to the user (product tours, coach marks, tooltips that appear automatically)
- **Pull**: The user finds information when they need it (documentation links, contextual tooltips on hover, help icons next to complex fields)

Expert users strongly prefer pull. They resist push. The principle: **never interrupt an expert user's flow to give them information they didn't ask for.** Surface help. Don't inject it.

**The empty-state exception:** Empty states are the one place where "push" information is acceptable, because the user has naturally reached a state of needing orientation. The empty state of the Pulse tab is genuinely the right moment to explain what Pulse does — because the user chose to navigate there.

### 4.3 The Anti-Persona Filter (Jordan, The Prompt Dabbler)

Jordan is a non-technical user who wants a hosted, no-code dashboard. Building FTUE with Jordan in mind would mean:
- Explaining what an "agent" is
- Providing templates for common use cases with no customization
- Hiding configuration entirely
- Softening technical terminology

Building FTUE for Kai means the opposite of all of those things. The filter is:

**If a design decision makes DorkOS easier for Jordan, it probably makes it worse for Kai.**

Specific anti-Jordan signals to preserve:
- Technical terminology should not be softened (sessions, not "conversations"; schedules, not "automations"; cwd, not "workspace folder")
- Configuration should be visible, not hidden — Kai wants to know what the flags are
- The README should lead with architecture, not benefits
- The empty states should assume the user knows what they want to build, not walk them through use cases

The goal is not to be exclusionary, but to be **specifically useful** to the people DorkOS is built for. A tool that tries to serve Kai and Jordan simultaneously will fail both.

---

## Round 5: Synthesis — FTUE Framework for DorkOS

### 5.1 Taxonomy of FTUE Approaches with DorkOS Assessment

#### Product Tours
**What it is:** A linear, step-by-step walkthrough of the product's key features, usually with modals, tooltips, or coach marks.

**Pros:** Systematic coverage, easy to implement with tools like Appcues or Chameleon, can be tracked analytically.

**Cons:** 16-33% completion rate. Patronizing for experts. Generic (treats all users the same). Creates "trapped" feeling. Dismissal ≠ understanding.

**DorkOS verdict:** **Hard no.** The target personas will immediately close any product tour and lose trust. If tours are implemented at all (e.g., for `dorkos init`), they must be: (a) CLI-based, not web UI-based, (b) explicitly opt-in, (c) 3 steps maximum, (d) interactive (user does something, not just reads).

#### Progressive Disclosure
**What it is:** The product's permanent information architecture reveals complexity only as users need it. Not a temporary onboarding state — a design philosophy.

**Pros:** Respects users at all skill levels simultaneously. Scales from first-time to power user. Reduces cognitive load without hiding capability.

**Cons:** Requires discipline in design — easy to let secondary features creep into primary views. Can hide advanced capabilities too well, leading to underdiscovery.

**DorkOS verdict:** **Primary FTUE strategy.** Chat is always the primary view. Pulse, Relay, Mesh are always secondary (tabs/nav items). Within each module, configuration is always secondary to usage. Within usage, advanced options are always secondary to basic operations.

#### Empty State Driven Onboarding
**What it is:** The first thing a user sees in any module is a well-designed empty state that explains the module's purpose, shows what it would look like populated, and provides a single clear action to populate it.

**Pros:** Contextually appropriate (appears only when the user navigates to the relevant section). Non-intrusive (doesn't interrupt flow). Teaches by doing rather than explaining.

**Cons:** Requires careful writing — the copy must do heavy explanatory lifting in minimal space. Might be missed by users who don't explore.

**DorkOS verdict:** **Primary FTUE mechanism for module discovery.** Every tab in DorkOS should have a world-class empty state. This is the highest-leverage design work for the FTUE.

#### Task-Driven / Goal-Driven Onboarding
**What it is:** The product asks the user what they want to accomplish and routes them to the relevant workflow. LinkedIn does this ("Are you here to job-hunt, recruit, or network?"). Typeform does this. Some developer tools do this with a role selector.

**Pros:** Highly relevant experience for diverse user bases. Demonstrates that the product understands different use cases.

**Cons:** Adds a decision step before showing value. Can feel like a survey. Risky if the user selects the "wrong" option and can't change it.

**DorkOS verdict:** **Potentially valuable for `dorkos init` wizard, not for the web UI FTUE.** The init wizard could ask "What do you want to do first?" with options like "Chat with an agent", "Schedule an agent to run automatically", "Connect this agent to others". This routes the user into relevant module documentation / setup steps without feeling like a survey. In the web UI, task-driven onboarding is implicit — the Chat tab is the default because Chat is the primary job.

#### Configuration as Onboarding
**What it is:** The act of configuring the tool (setting env vars, editing JSON) IS the onboarding — it forces the user to understand the tool's architecture by building it.

**Pros:** Matches the mental model of experienced developers. Produces expertise, not just familiarity. Aligns with the "read the source code" philosophy.

**Cons:** High friction for getting started. Abandonment risk if configuration fails silently. Not suitable as a primary FTUE mechanism.

**DorkOS verdict:** **Secondary mechanism for module activation.** Feature flags (DORKOS_RELAY_ENABLED etc.) should be surfaced in the UI with clear env var instructions when a user navigates to a disabled module. This makes configuration contextually appropriate rather than front-loaded.

#### Documentation as Onboarding
**What it is:** The README, the docs site, and the in-code comments ARE the onboarding. Tools like Stripe treat time-to-first-API-call as the north-star metric, with docs as the primary activation path.

**Pros:** Ideal for expert users who prefer reading over guided experiences. Permanent reference, not a one-time flow. Highly compatible with the "no marketing language" preference.

**Cons:** Requires genuinely excellent documentation (easy to say, hard to do). Can't surface contextually within the product.

**DorkOS verdict:** **Critical for Kai's journey. The README and `dorkos --help` are the first touchpoints.** Documentation must be technical, honest, and exhaustive. The `contributing/` guides provide a model. The `docs/` site should have a clear quickstart that gets from `npm install -g dorkos` to first session in under 5 minutes.

### 5.2 Persona-Specific Ideal First 5 Minutes

#### Kai's Ideal First 5 Minutes (The Autonomous Builder)

**Minute 0:** Reads the README. Sees the architecture overview immediately (not a marketing pitch). Sees `npm install -g dorkos`. Copies. Runs.

**Minute 1:** `dorkos` starts. The CLI outputs clean diagnostic information: port, directory, features enabled. Browser opens (or link provided — Kai may prefer to open it himself). The server is running.

**Minute 2:** Opens the web UI. Sees the chat interface — no tour, no welcome modal. The session sidebar is empty but the empty state makes clear what to do: "Open a session in your project directory." Kai's cwd is pre-populated (inferred from where he ran `dorkos` or from `DORKOS_DEFAULT_CWD`). He clicks. A session starts.

**Minute 3:** The session is running. Claude Code responds. Kai recognizes the interface — it's the same Claude Code behavior he knows. He understands immediately what this tool is: a web interface for Claude Code, not a chatbot wrapper. Trust established.

**Minute 4:** He notices the "Pulse" tab in the sidebar. Its badge or visual treatment is clearly "secondary but available." He clicks out of curiosity. Empty state says: "Schedules let your agents run automatically on a timer. Create your first schedule." Kai thinks: "This is what I came for." He creates a schedule.

**Minute 5:** The schedule is created. He sees the next run time. He understands the tool is doing what he needed it to do — enabling autonomous agent execution. He closes the browser and lets it run overnight.

**What made this work:**
- No friction between install and first session
- Sensible cwd inference — no configuration decision required
- Empty states explained secondary features at exactly the right moment (when he chose to navigate there)
- The first experience confirmed his hypothesis (this is not a chatbot wrapper) before he had to take it on faith

#### Priya's Ideal First 5 Minutes (The Knowledge Architect)

**Minute 0:** Discovers DorkOS through a reference in an Obsidian plugin directory or from a colleague. Reads the Obsidian plugin documentation on the docs site. Sees that the plugin integrates Claude Code into Obsidian natively. Downloads the plugin.

**Minute 1:** Installs the Obsidian plugin. The plugin's activation either auto-starts the DorkOS server or prompts for a server URL. If the server isn't running, the plugin tells her to run `npm install -g dorkos && dorkos` — clean CLI instructions embedded in the plugin UI.

**Minute 2:** The plugin loads in Obsidian. Priya sees a panel — not just a chat widget, but something that feels integrated. The empty state is thoughtful: "Ask Claude Code about your notes, run code, or execute tasks. Your vault is the context."

**Minute 3:** Priya types a question about one of her notes. Claude Code responds with context that references her vault. The integration is real. This is not a chat widget — it's Claude Code with vault awareness. The "aha" moment arrives.

**Minute 4:** She explores the agent identity settings — she can name this agent, give it a persona, configure its behavior. This connects to her "Knowledge Architect" identity. The agent becomes an extension of her thinking, not a generic tool.

**Minute 5:** She closes the plugin panel and thinks: "I want this running while I write." She doesn't need to configure anything else right now. The deep integrations (Relay, Mesh) can wait until she needs them.

**What made this work:**
- The plugin's entry point is the vault, not the server — her world, her terms
- No context switching required — Claude Code lives in Obsidian
- The agent identity feature satisfied her "clean architecture" instinct — she can name and shape the tool
- Empty state was appropriately brief but conveyed the depth of integration

### 5.3 How NOT to Build for Jordan (The Anti-Persona Filter)

The Jordan filter is active throughout FTUE design. For each decision, ask: "Would this design decision make Jordan more comfortable?" If yes, it probably needs reconsideration.

**Jordan-ification patterns to avoid:**
- Replacing `cwd` with "project folder" in the UI (obfuscates, doesn't clarify)
- A "What would you like to build today?" welcome modal with use case templates (assumes users don't know what they want)
- Hiding the `.env` configuration in favor of a GUI settings panel (removes power user access)
- Progress trackers showing "50% setup complete" — treats expertise as a destination, not a starting point
- Any copy that says "simple", "easy", or "no code required" — those are signals to Jordan, not to Kai

**The correct frame:** DorkOS should feel like discovering a tool that was built specifically for you (Kai). Not like a tool that was built for everyone and simplified to be accessible. That distinction — discovered vs. handed-to — is the core emotional difference between an excellent developer tool FTUE and an average one.

### 5.4 The Recommended FTUE Framework for DorkOS

This framework covers the full journey from CLI install to multi-module discovery.

---

#### Layer 0: Pre-Install (README + Docs)
**The principle:** The README is the first UI. Treat it as a product surface.

**Concrete implementation:**
- Open with architecture description, not marketing pitch. First paragraph is technical: "DorkOS is an OS-layer for AI agents — a web interface and REST/SSE API for Claude Code, built on the Claude Agent SDK."
- Second paragraph: the feature list, stated plainly. Pulse. Relay. Mesh. Each in one sentence.
- Third: `npm install -g dorkos` as a standalone code block.
- Fourth: what you'll see when it runs (port, interface URL, what to expect).
- No badges that say "100% TypeScript" or "MIT Licensed" before the what-it-is.
- No marketing copy like "supercharge your agents" or "unlock AI-powered workflows."

---

#### Layer 1: CLI First Run (`dorkos`)
**The principle:** The terminal is the first product surface. Make it speak clearly.

**Concrete implementation:**
- On first run with no `.env`, DorkOS starts with sensible defaults and outputs a clean startup message:
  ```
  DorkOS v1.x.x
  Server: http://localhost:4242
  Directory: /Users/kai/projects (detected from cwd)
  Features: Chat enabled | Pulse disabled | Relay disabled | Mesh disabled

  To enable additional features, see: https://dorkos.ai/docs/configuration
  ```
- No "Welcome to DorkOS!" message. No ASCII art. Output that is greppable, informative, and clean.
- On first run only, append a single line: "New to DorkOS? Start a session at http://localhost:4242" — then never again (store a first-run flag).
- `dorkos --help` is comprehensive, includes all env vars, links to docs.
- `dorkos init` (optional wizard) asks: "What's your primary project directory?" and "Which features would you like to enable?" — 2-3 questions max, all skippable.

---

#### Layer 2: Web UI First Open
**The principle:** The web UI should confirm the user's hypothesis, not introduce itself.

**Concrete implementation:**
- No welcome modal on first open.
- No product tour.
- No "Let's get started" checklist (unless explicitly opt-in from a `dorkos init` choice).
- Default to the Chat view — a clean, empty session list with a focused empty state:

  ```
  No sessions yet.

  Start a session in your project:
  [/Users/kai/projects] ▼  [New Session]
  ```

  The directory picker defaults to the configured cwd or detected cwd. Clicking "New Session" immediately opens a session — no intermediate confirmation dialog.

- The sidebar shows: Sessions (primary), Pulse, Relay, Mesh, Settings. The secondary tabs are styled with lower visual weight — visible but clearly not demanding immediate attention.

---

#### Layer 3: Module Discovery (Progressive Disclosure via Empty States)
**The principle:** Modules explain themselves when visited, not before.

**Pulse Empty State:**
```
No schedules yet.

Schedules run your agents automatically — on a timer, overnight, or on a cron expression.
The agent runs in its own session and reports back when done.

[Create your first schedule]  [View documentation →]

Example: Run a codebase health check every Monday at 9am.
```

**Relay Empty State:**
```
Relay is not enabled.

Relay lets your agents communicate with each other and with external systems
(Slack, webhooks, other agents).

To enable Relay, add to your .env:
DORKOS_RELAY_ENABLED=true  [Copy]

[View Relay documentation →]
```

**Mesh Empty State:**
```
No agents registered.

Mesh makes your agents discoverable to each other across projects and machines.
Register an agent to see the topology graph.

[Register current agent]  [View Mesh documentation →]
```

---

#### Layer 4: Feature Activation (Configuration as Progressive Unlock)
**The principle:** Feature flags are power-user affordances, not setup burdens.

**Concrete implementation:**
- Disabled modules show their empty states with env var instructions (as above)
- The Settings panel has a "Features" section that shows which features are active and which are available, with copy-able env var blocks for each
- No GUI toggle that secretly sets env vars — transparency about what's happening in the config layer is a feature, not a bug, for Kai

---

#### Layer 5: Return Use / Habit Formation (The Investment Phase)
**The principle:** After the first 5 minutes, FTUE is over. Habit formation begins.

**Concrete implementation:**
- Sessions are remembered — the sidebar shows recent sessions with titles extracted from first message
- The cwd is remembered — no re-configuration on every launch
- Agent identity (name, persona) can be set and is persisted — Kai can name his main agent, building the "investment" that drives return
- Status bar shows active sessions, next scheduled run, agent identity — periphery information that doesn't demand attention but rewards attention when given
- The command palette (⌘+K equivalent) surfaces all available actions — Kai discovers advanced features by searching for intent, not by exploring menus

---

## Key Findings

1. **The README is the first UI.** For expert developer users, the documentation is the FTUE. It must be technically honest, precise, and lead with architecture — not marketing. This is the highest-leverage change for Kai's adoption.

2. **Product tours are anti-patterns for DorkOS.** With a target persona who explicitly cites "marketing language with no technical substance" as an anti-adoption signal, any guided tour that runs without being explicitly requested is a trust violation.

3. **Progressive disclosure is a design philosophy, not a feature.** The entire information architecture should reflect this: Chat primary, modules secondary, configuration tertiary. Within each module, basic operations primary, advanced configuration secondary.

4. **Empty states are the most valuable FTUE real estate.** Each module's empty state should explain purpose, show a minimal example, and provide one clear action. These are encountered naturally (when the user chooses to explore) rather than imposed (before the user has any context).

5. **Configuration-as-progressive-unlock is the right model for feature flags.** Disabled modules should surface their activation env var with a copy button, not hide behind a "contact sales" or require documentation excavation.

6. **Kai's ideal journey is: install → server starts → session opens → schedule created. Under 5 minutes.** Every design decision should be evaluated against this path.

7. **Priya's ideal journey is: find plugin → install in Obsidian → link to server → Claude Code responds with vault context.** The Obsidian plugin needs a distinct FTUE tailored to vault-first users.

8. **Fogg's Law applies:** Don't try to increase motivation (marketing copy, social proof). Decrease friction (zero-config defaults, sensible cwd inference, pre-populated directory pickers).

9. **The anti-persona filter is a design constraint.** If a design decision makes DorkOS easier for Jordan (non-technical, wants templates and no-code), it probably makes it worse for Kai. Technical terminology, visible configuration, and architectural transparency are features, not obstacles.

10. **The "investment phase" (Nir Eyal) is the FTUE's hidden goal.** Getting Kai to name his agent, create his first schedule, or configure his preferred cwd is more valuable than any amount of feature explanation — because invested users return.

---

## Detailed Analysis

### On the "Considerate Interface" Goal

The user's stated preference — "I like progressive disclosure, and considerate interfaces that help you do what YOU want to do" — maps precisely to Alan Cooper's considerate software principles. The key tension in building a considerate interface for DorkOS:

**The tool knows things the user doesn't need to manage.** DorkOS manages Claude Agent SDK sessions, JSONL transcripts, SSE streaming, Pulse SQLite databases, and Relay message buses. None of this should surface in the FTUE. A considerate interface surfaces the user's intent (run an agent, schedule a task, route a message) without exposing the machinery behind it.

**The tool doesn't know things the user expects it to.** The user's cwd, their project context, which agents are theirs, what they want the agent to do — none of this can be inferred without input. A considerate interface minimizes the questions needed to establish this context, and remembers the answers so they're only asked once.

**The balance:** Surface the minimum configuration required, remember everything supplied, never ask twice.

### On CLI-to-Web FTUE Continuity

The journey from `npm install -g dorkos` to the web UI is a continuity problem. Users who start in the terminal will arrive at the web UI with mental context (they know the port, they set the cwd, they may have run init). The web UI should confirm this context, not restart the orientation.

The status bar's role is critical here: showing the current cwd, the server port, the detected Claude CLI path, and the active feature flags at a glance means Kai can confirm that the tool is configured correctly without reading documentation. This is the "Keeps You Informed" principle from the considerate software framework.

### On the Obsidian Plugin FTUE

The Obsidian plugin is a separate product surface with a distinct FTUE challenge. Obsidian users are note-takers, writers, knowledge workers who happen to use Claude Code — not developers who happen to take notes. The plugin's FTUE must:

- Speak the language of Obsidian (vault, note, backlink) before the language of DorkOS (session, cwd, agent)
- Make the first interaction about their content, not about the tool's capabilities
- Avoid requiring server configuration to be visible — the plugin should handle server connectivity abstractly

The empty state of the Obsidian plugin panel should reference the vault explicitly: "Ask Claude Code about your notes or execute tasks in your vault context." This confirms the deep integration Priya is looking for.

### On "Time to Value" as the FTUE Metric

The north-star metric for DorkOS's FTUE should be: **time from `npm install -g dorkos` to first agent session response.** This should be under 3 minutes.

For the secondary metric: **time from first agent session to first scheduled run.** This should be under 10 minutes from install.

These metrics are not about marketing benchmarks — they're about validating that the FTUE is working. If users regularly abandon before seeing a session response, the friction is in Layer 1-2. If users see a session but don't discover Pulse, the friction is in the empty state at Layer 3.

---

## Research Gaps and Limitations

- **No direct user research on DorkOS.** All recommendations are synthesized from analogous tools. The specific friction points for DorkOS's FTUE require usability testing with real Kai/Priya personas.
- **The Obsidian plugin FTUE is underspecified.** More research into Obsidian plugin UX conventions would strengthen the Priya recommendations.
- **No data on CLI-to-web-UI FTUE continuity patterns.** This is an underresearched area in the literature; most research focuses on either CLI or web UI in isolation.
- **Feature flag UX for self-hosted tools** has limited published research. The empty-state + copy-button pattern is a synthesis from multiple sources rather than a documented best practice from a specific tool.

---

## Contradictions and Disputes

**Progressive disclosure vs. discoverability:** There is a real tension between hiding complexity and ensuring advanced features are discovered. Some research suggests power users are frustrated when they can't find advanced capabilities — not because of cognitive load, but because they expect them and can't locate them. The resolution: progressive disclosure must be paired with a powerful search/command interface (the command palette) so that advanced features are findable by intent even when not visible by default.

**Empty states vs. demo content:** The Notion research suggests pre-populated template content improves retention, while other research suggests "fake" data creates confusion when users try to delete it. For DorkOS, the recommendation is: no fake data, but very high-quality empty state copy that conveys what a populated state would look like.

**Init wizard vs. no wizard:** Linear built a world-class FTUE without relying on an extensive wizard. Stripe doesn't use one either. But self-hosted tools (Coolify, n8n) show that wizards can reduce configuration abandonment significantly when the tool requires infrastructure decisions. For DorkOS, `dorkos init` should exist as an opt-in wizard (invoked explicitly), not as a mandatory first-run flow.

---

## Search Methodology

- Number of searches performed: 22
- Most productive search terms: "why product tours fail onboarding research", "linear app FTUX onboarding", "considerate software design Alan Cooper", "dev tool activation hurdles boldstart", "arc browser progressive disclosure AI feature", "empty state design NN/G", "goal-oriented onboarding", "CLI UX patterns first run"
- Primary information sources: Nielsen Norman Group, Heavybit, boldstart.vc, GrowthDives, onboardme.substack.com, appcues.com, screeb.app, interaction-design.org, userpilot.com, codinghorror.com

---

## Sources and Evidence

- "Product tours typically cause 40-60% user drop-off before users reach their first 'aha!' moment" — [The Hidden Metrics of Effective Product Tours](https://www.chameleon.io/blog/effective-product-tour-metrics)
- "For tours with 2-6 cards, 33.05% of users reach the final card, but for tours with 7-11 cards, the percentage drops by more than 50%" — [Chameleon: Effective Product Tour Metrics](https://www.chameleon.io/blog/effective-product-tour-metrics)
- "User-triggered tours outperform delayed or blanket triggers by 2–3×" — [Why Most Product Tours Fail](https://screeb.app/blog/why-most-product-tours-fail-and-what-you-should-do-instead)
- "Progressive disclosure defers advanced or rarely used features to a secondary screen, making applications easier to learn and less error-prone" — [NN/G: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- "Designs that go beyond 2 disclosure levels typically have low usability" — [NN/G: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- The 13 principles of considerate software — [Making Considerate Software](https://blog.codinghorror.com/making-considerate-software/) (citing Cooper & Reimann's "About Face")
- "Increasing Ability (making the behavior easier) is almost always more effective and more sustainable than trying to increase Motivation" — [Fogg Behavior Model](https://www.behaviormodel.org/)
- "Linear's onboarding isn't trying to be impressive or clever — it doesn't rely on animations, product tours or growth tricks, but instead shows you that it's a tool designed for you" — [The Onboarding Linear Built Without Any AB Testing](https://www.growthdives.com/p/the-onboarding-linear-built-without)
- Arc Browser's 90-second AI feature onboarding analysis — [How Arc Browser Introduces AI Feature Using Progressive Disclosure](https://onboardme.substack.com/p/how-arc-browser-introduces-ai-max-feature)
- The three functions of empty states — [Designing Empty States in Complex Applications](https://www.nngroup.com/articles/empty-state-interface-design/)
- The three developer tool activation hurdles (Approval Required, Cold Starts, Single-User Limitation) — [Clearing the 3 Biggest Dev Tool Activation Hurdles](https://boldstart.vc/resources/clearing-the-3-biggest-dev-tool-activation-hurdles/)
- "34.7% of developers will abandon a tool if setup is difficult" — [What 202 Open Source Developers Taught Us About Tool Adoption](https://www.catchyagency.com/post/what-202-open-source-developers-taught-us-about-tool-adoption)
- "73% of developers want tutorials and quickstarts first" — [What 202 Open Source Developers Taught Us About Tool Adoption](https://www.catchyagency.com/post/what-202-open-source-developers-taught-us-about-tool-adoption)
- Notion's template-based blank canvas solution — [How Notion Solved the Blank Page Problem](https://onboardme.substack.com/p/how-notion-solved-the-blank-page-product-strategy-deepdive)
- "Users who start with templates almost always stick with the platform longer than those who start from scratch" — [Notion: Blank Page Problem](https://wyndomb.medium.com/how-notion-solved-the-blank-page-problem-686b2e73ae57)
- CLI UX patterns for first-time experience — [UX Patterns for CLI Tools](https://www.lucasfcosta.com/blog/ux-patterns-cli-tools)
- Nir Eyal on habit-forming developer products — [Interview: Nir Eyal on Building Habit-Forming Developer Products](https://www.heavybit.com/library/article/nir-eyal-hooked-on-product/)
- Goal-oriented onboarding framework — [Designing Goal-Oriented User Onboarding](https://www.appcues.com/blog/designing-goal-oriented-user-onboarding)
- State of UX 2026 — [NN/G: State of UX 2026](https://www.nngroup.com/articles/state-of-ux-2026/)
- Calm technology principles — [Calm Technology and Enterprise Web Applications](https://fuzzymath.com/blog/calm-technology-enterprise-web-application-ui-design/)
