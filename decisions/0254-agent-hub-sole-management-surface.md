---
number: 254
title: AgentHub as Sole Agent Lifecycle Management Surface
status: accepted
created: 2026-04-14
spec: agent-hub-management-actions
superseded-by: null
---

# 0254. AgentHub as Sole Agent Lifecycle Management Surface

## Status

Accepted

## Context

Agent lifecycle actions (unregister, deny, delete) were scattered: unregister lived in the agents-list table overflow menu, deny had a hook but no UI, and delete-data didn't exist. ADR-0166 established the `/agents` page as the single agent management surface, but management actions weren't consolidated into the AgentHub panel that users already use for agent editing.

## Decision

All agent lifecycle management actions (unregister, deny/block, delete agent & data) live exclusively in the AgentHub panel's overflow menu. The agents-list table provides only navigation — split Chat and Manage buttons per row — with no inline management actions. This extends ADR-0166's principle to the action level.

## Consequences

### Positive

- Single, predictable location for all agent management — reduces user confusion
- Agents-list stays focused on navigation and at-a-glance fleet status
- Fewer callbacks and less state management in the agents-list component
- Management actions have full agent context (the hub already loads identity, config, health)

### Negative

- Managing an agent requires two interactions from the list (click Manage → then use menu), rather than one overflow menu click
- If the AgentHub panel is broken or slow to load, management actions are inaccessible
