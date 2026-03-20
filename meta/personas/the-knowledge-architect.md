# Priya Sharma — The Knowledge Architect

**Role**: Secondary persona
**Confidence**: Proto-persona (assumption-based)
**Created**: 2026-02-27
**Review by**: 2026-08-27

---

## Demographics

- **Age**: 30-40
- **Role**: Staff engineer / technical architect / developer advocate
- **Company**: Mid-stage startup (20-100 people) or consultancy
- **Technical level**: Advanced — strong with TypeScript, comfortable building tools
- **Tools**: Obsidian (daily driver), Claude Code, multiple repos, Zettelkasten or similar note system
- **Location**: Hybrid — office 2-3 days, remote the rest

## Context

Priya manages architecture across multiple services. They maintain extensive Obsidian vaults with ADRs, meeting notes, system designs, and personal knowledge. They use Claude Code for implementation but context-switch constantly between "thinking" (in Obsidian) and "doing" (in the terminal). They want the agent available inside their thinking environment, not just their coding environment.

Priya doesn't just write code — they design systems. The agent is most valuable when it can participate in the design process, not just the implementation.

## Trigger

Priya is writing an architecture doc in Obsidian and realizes they need to check whether the current codebase already handles a pattern they're describing. Switching to the terminal breaks their flow. They think: "Why can't I just ask the agent from here?"

## The Worst Day

Priya is 40 minutes into a flow state — deep in an Obsidian doc, mapping a complex service interaction. The dependency graph is clear in their head. They need to verify one thing: does the auth service already handle token refresh, or is that a gap?

Alt-tab to terminal. Open Claude Code. Three paragraphs of context to set up the question — the agent doesn't know what Priya's been thinking about. Wait for the answer. Get it. Alt-tab back to Obsidian. Stare at the document. The mental model is gone. Fifteen minutes re-reading their own notes, trying to reconstruct where they were.

The answer took 10 seconds. The context loss cost 15 minutes. This happens four or five times a day. Priya's best thinking is constantly interrupted by the gap between their thinking tool and their doing tool.

Priya thinks: "I have the best note system and the best coding agent. And they don't know about each other."

## Jobs to Be Done

- When I'm writing architecture docs in Obsidian, I want to query my coding agent without leaving Obsidian, so that I stay in flow.
- When I have context scattered across notes and repos, I want the agent to have access to both, so that its answers reflect the full picture.
- When I review sessions later, I want them visible from any client (Obsidian, browser, phone), so that I can pick up where I left off.

## Goals

1. Unify the "thinking" and "doing" environments
2. Maintain a knowledge system that agents can draw from
3. Share session context across multiple clients seamlessly

## Frustrations

1. Context-switching between Obsidian and terminal kills flow
2. Agent sessions aren't visible across different clients
3. Architecture decisions live in notes but agents can't access them
4. Existing Obsidian AI plugins are shallow chatbot wrappers
5. Having to re-explain context every session feels like training a new intern every day

## Quote

"My best thinking happens in Obsidian. My best execution happens with Claude Code. I need them in the same place."

## How Priya Talks (Language Patterns)

When describing the problem to a colleague:

- "I was in the middle of a design doc and had to context-switch to the terminal"
- "Every time I switch, I lose 15 minutes of mental state"
- "The thinking environment and the doing environment should be the same"
- "It's a shallow chatbot wrapper — it doesn't actually integrate"
- "Cross-cutting concern" / "separation of concerns" (thinks in architecture)

When excited about a tool:

- "It just... stays out of the way"
- "I queried the agent without leaving my doc"
- "The session I started in Obsidian was right there in the browser later"
- "Clean abstraction" / "well-designed interface"

Technical vocabulary: Transport layer, adapter pattern, hexagonal architecture, session state, in-process, zero network hop

## What Priya Brags About

- The elegance of their Zettelkasten system
- Architectural decisions that proved correct months later
- Systems that "just work" because they designed them well
- Tools that integrate seamlessly without friction
- "My notes, my agents, and my code — all connected"

## Fears & Objections

- "Will the Obsidian plugin be maintained long-term?" (abandonment risk)
- "Is this another plugin that breaks with every Obsidian update?" (stability)
- "Does it respect my vault structure or does it pollute it?" (tool hygiene)
- "Does it introduce vendor lock-in?" (architectural concern)
- "Will the DirectTransport path stay performant as features grow?" (technical debt)

## Media Consumption

- **Daily**: Obsidian community forums and Discord, Twitter/X (architects, system thinkers, tools-for-thought)
- **Tech reading**: InfoQ, ThoughtWorks Technology Radar, Martin Fowler's blog, Lethain
- **Newsletters**: Software Architecture Weekly, Kent Beck's newsletter, Alex Xu's System Design
- **Conferences**: QCon, Strange Loop, local architecture meetups
- **Reddit**: r/ObsidianMD, r/ExperiencedDevs, r/softwarearchitecture
- **YouTube**: CodeOpinion, ArjanCodes, systems design content

## Buying Triggers

- Discovers the Obsidian plugin and realizes it's not just a chatbot wrapper
- Sees that sessions started in Obsidian appear in the browser (shared state!)
- Reads about the Transport architecture and recognizes clean, extensible design
- Hears about it from the Obsidian community or tools-for-thought circles
- Sees a demo of query-from-Obsidian → review-in-browser → approve-from-phone

## Anti-Adoption Signals

- If the Obsidian plugin was just a chat widget with no deep integration
- If sessions started in Obsidian weren't visible in the browser UI
- If it required leaving Obsidian to approve tool calls
- If the architecture was messy or tightly coupled (Priya reads source code)
- If the documentation was thin or marketing-heavy

## Key Assumptions to Validate

1. Obsidian users who also use Claude Code are a meaningful segment (not a niche of a niche)
2. The "thinking + doing" pain point resonates more than just "I want chat in Obsidian"
3. Cross-client session visibility is actually valued vs. people just using one client
4. Flow preservation is the primary emotional driver (vs. convenience)
5. Priya reads the architecture before adopting — clean code is a prerequisite
