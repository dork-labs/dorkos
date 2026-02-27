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

## Context

Priya manages architecture across multiple services. They maintain extensive Obsidian vaults with ADRs, meeting notes, system designs, and personal knowledge. They use Claude Code for implementation but context-switch constantly between "thinking" (in Obsidian) and "doing" (in the terminal). They want the agent available inside their thinking environment, not just their coding environment.

## Trigger

Priya is writing an architecture doc in Obsidian and realizes they need to check whether the current codebase already handles a pattern they're describing. Switching to the terminal breaks their flow. They think: "Why can't I just ask the agent from here?"

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

## Quote

"My best thinking happens in Obsidian. My best execution happens with Claude Code. I need them in the same place."

## Anti-Adoption Signals

- If the Obsidian plugin was just a chat widget with no deep integration
- If sessions started in Obsidian weren't visible in the browser UI
- If it required leaving Obsidian to approve tool calls

## Key Assumptions to Validate

1. Obsidian users who also use Claude Code are a meaningful segment (not a niche of a niche)
2. The "thinking + doing" pain point resonates more than just "I want chat in Obsidian"
3. Cross-client session visibility is actually valued vs. people just using one client
