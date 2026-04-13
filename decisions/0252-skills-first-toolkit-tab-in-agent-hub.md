---
number: 252
title: Skills-First Toolkit Tab in Agent Hub
status: draft
created: 2026-04-13
spec: marketplace-scoped-installs
superseded-by: null
---

# 252. Skills-First Toolkit Tab in Agent Hub

## Status

Draft (auto-extracted from spec: marketplace-scoped-installs)

## Context

The agent hub has two tabs (Sessions, Config). Agent capabilities — skills from marketplace skill-packs and tool group toggles (tasks, relay, mesh, adapter) — are buried in the Config tab's "Tools & MCP" accordion. Research across 9 agent platforms (Copilot Studio, VS Code Copilot, CrewAI, AutoGen Studio, etc.) found that dedicated skills sections per agent are an emerging industry standard. "Skills" is converging as the user-facing term for installable agent capabilities (SKILL.md open standard adopted by Anthropic, OpenAI, GitHub, Microsoft).

## Decision

Add a third "Toolkit" tab to the agent hub that combines Skills (from marketplace skill-packs) and Tools & MCP (existing tool group toggles + MCP configuration) into a single "what can this agent do?" view. Remove the "Tools & MCP" accordion from the Config tab. Use "Skills" as the primary user-facing term for SKILL.md capabilities and "Toolkit" as the tab name encompassing both skills and tools.

## Consequences

### Positive

- Skills become a first-class, discoverable concept in the agent management UI
- Single location for all agent capability configuration
- Aligns with industry patterns (Copilot Studio, VS Code Copilot)
- "Toolkit" metaphor is intuitive — one place for everything an agent can use

### Negative

- Goes from 2 to 3 tabs in the agent hub (mild complexity increase)
- Tools & MCP moves out of Config, which may temporarily confuse existing users
- Skills section requires a new data fetch (scoped installed packages query)
