# Feature Ranking: What We Have, Ordered by What It's Worth

> Positioning review deliverable (July 2026). Every shipped, user-facing capability, rank-ordered by marketing value under the new positioning (`02-positioning.md`): differentiation x demoability x persona pull. Benefit statements are written in outcome language (brand rule: describe what happens for the user). Source: full commit/changelog inventory, verified against the repo.

## Tier 1: The story (lead with these everywhere)

**1. Multi-runtime cockpit** (Claude Code, Codex, OpenCode; per-session choice)
_Benefit:_ run any agent from one place; pick the right brain per task; never bet your workflow on one vendor.
_Why #1:_ the claim no first party can make and no peer product has. It converts vendor competition into a DorkOS feature. Currently invisible on every marketing surface; fixing that is the single cheapest positioning win available.

**2. The live fleet cockpit** (durable sessions, cross-client sync, multi-device)
_Benefit:_ every session, every project, every device. Start in the terminal, review on your phone, approve from Obsidian; nothing is lost on refresh, restart, or reconnect.
_Why:_ this is the daily-driver value that makes DorkOS the tab that stays open. The durable-stream engineering (snapshot/replay/live) is genuinely hard and genuinely done; peers show stale session lists.

**3. Tasks: scheduled autonomy** (cron jobs, run history, overrun protection, safety gates)
_Benefit:_ your ideas keep moving while you do something else; wake up to finished work and a note about it.
_Why:_ the dream feature and the emotional heart of the story. Demoted from hero to proof (first parties now offer single-vendor versions) but still the moment that makes the demo land.

**4. Relay: agents that reach you and each other** (Telegram/Slack/webhooks, inter-agent messaging, budget envelopes)
_Benefit:_ get a Telegram message when your agent finishes; answer its question from the couch; let your test agent tell your deploy agent what happened.
_Why:_ the retention hook (notifications are why people come back) and the ingredient peers lack entirely. Inter-agent messaging is the "coordination layer, not dashboard" proof.

## Tier 2: The differentiators (second beat of every pitch)

**5. Marketplace** (agents, plugins, skill packs; one-command install; scoped installs; also an MCP server; **strict superset of the Claude Code plugin-marketplace format**)
_Benefit:_ install a working agent or skill pack in one command; and because DorkOS speaks Anthropic's marketplace format, every existing Claude Code plugin already works here, day one.
_Why:_ the flywheel, and the shelf is not empty at launch: it starts stocked with the largest agent-plugin ecosystem in the world. ClawHub proved skills marketplaces compound; DorkOS's is live, MCP-reachable from other tools, and bidirectionally compatible (DorkOS marketplaces serve plain Claude Code users too). Superset claim needs verification against popular real-world plugins before public use (`09-gtm-plan.md` §2.5).

**6. Trust controls** (tool approvals, permission modes, per-agent tool filtering, honest data-flow story)
_Benefit:_ let agents run exactly as far as you trust them, and see everything they did.
_Why:_ the enabler of everything above (autonomy without controls is a horror story) and, post-OpenClaw, a first-class buying criterion. Pair with a published security posture to convert it from feature to positioning.

**7. Remote access** (tunnel, passcode, QR to phone)
_Benefit:_ check on your agents from anywhere; approve a tool call from your phone at lunch.
_Why:_ the demo-wow moment and the customer-voice #1 historical complaint. First parties now offer flavors of this, so it supports rather than leads.

**8. Mesh: agent discovery and topology** (scan, register, identity manifests, network graph, access rules)
_Benefit:_ every project on your disk can become a named agent; see your whole team and who can talk to whom on one map.
_Why:_ the vision feature. Slightly ahead of what most users do today, which makes it perfect _second-visit_ content and architecture-persona bait; don't lead with it.

**9. Four surfaces** (web, desktop app, Obsidian plugin, phone via tunnel)
_Benefit:_ your agents live where you think and work, not in one more app you have to visit.
_Why:_ Obsidian alone unlocks an unserved niche with a concentrated distribution channel; the four-surface story makes "control plane" concrete. Currently a secret (zero site mentions).

## Tier 3: The credibility layer (docs, evaluation pages, architecture content)

**10. MCP control plane** (all DorkOS tools exposed at `/mcp`)
_Benefit:_ drive DorkOS from Cursor, ChatGPT, or any MCP client; script your fleet from anything.
_Why:_ infrastructure-credibility and an integration surface others build on. Speaks to Priya and to toolmakers.

**11. Agent identity and personas** (names, colors, icons, personality, SOUL.md, DorkBot)
_Benefit:_ your agents feel like a team, not a process list.
_Why:_ the emotional texture of the "standing organization" future; great screenshots; low standalone pull.

**12. Canvas** (file-backed live documents beside chat, cross-runtime)
_Benefit:_ agents draft real files you can edit, live, next to the conversation.
_Why:_ differentiated UX craft; a strong demo beat rather than a reason to adopt.

**13. Workspaces** (directory-scoped sessions and bindings)
_Benefit:_ the right agent in the right project, always.
_Why:_ quietly load-bearing; markets as part of the cockpit story, not alone.

**14. Extensions + extension API** (agent-built extensions, settings UI generation)
_Benefit:_ your agents can extend their own control panel.
_Why:_ a genuinely wild capability that deserves one great blog post; too meta to carry front-page weight.

**15. Harness sync** (`.agents/` projected to every coding-agent harness)
_Benefit:_ write your rules and skills once; every tool you use (Cursor, Copilot, the CLIs) gets them automatically, including anything you just installed from the marketplace.
_Why:_ solves real sprawl pain, earns dev-infra respect, and removes the switching-cost objection (adopting DorkOS upgrades your existing tools instead of replacing them). No known peer has it; ranked here as a standalone feature, but see Combination plays below, where it punches far above this slot.

**16. A2A gateway** (cross-platform agent interop protocol)
_Benefit:_ your fleet can talk to agent ecosystems beyond DorkOS.
_Why:_ strategic option value; mention in architecture content only.

**17. CLI + ops polish** (one-command install, Docker/GHCR, config precedence, `dorkos cleanup`, OpenAPI docs at `/api/docs`)
_Benefit:_ installs like a real tool, behaves like a real server, documented like a real API.
_Why:_ not a differentiator, but the absence would be one. Evaluation-stage proof for the source-reading persona.

## Combination plays (features that multiply each other)

Individual rankings undersell three compositions (founder insight, 2026-07-06):

1. **The capability pipeline** = Marketplace superset (#5) x Harness sync (#15) x Tasks-are-skills (#3). Install any Claude Code plugin → it works in every harness you use → any of its skills can be scheduled as an autonomous job. Three clicks from "saw a plugin" to "it runs itself nightly, everywhere." No peer or first party composes these. Present as a 20-second demo, never as an explanation. (Full treatment: `02-positioning.md` §6.)
2. **The privacy stack** = OpenCode local models x self-hosted x Trust controls (#6). A session that provably never leaves the machine, inside the same cockpit as the cloud runtimes. Converts "private by design" from a policy claim into a demo, and gives the r/LocalLLaMA audience a real reason to care.
3. **Tasks-are-skills** on its own is also a quiet architectural flex: scheduling is not a separate subsystem to learn; a task is a skill with a clock. Worth one architecture essay; users feel it as "anything my agent can do, it can do on a schedule."

## What this ranking implies

- **Site featured-6 should be:** Multi-runtime, Fleet cockpit, Tasks, Relay, Marketplace, Trust controls. (Today's featured set is Chat, Tasks, Relay, Agent Discovery, Topology Graph, MCP Server: it leads with #2/#3 material and two Tier-2/3 vision features while omitting #1 and #5 entirely.)
- **The launch demo runs the tiers in order:** one cockpit with three runtimes (10s) → the fleet screen (10s) → schedule a task (15s) → the Telegram ping arrives (15s) → "and it's all on your machine, MIT" (5s).
- **Docs/blog depth goes to Tier 3:** that is where the architecture-reader persona converts.
