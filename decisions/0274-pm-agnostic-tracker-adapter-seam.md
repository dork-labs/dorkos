---
number: 274
title: Isolate Tracker I/O Behind a PM-Agnostic Adapter Seam
status: accepted
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 274. Isolate Tracker I/O Behind a PM-Agnostic Adapter Seam

## Status

Accepted (implemented in spec: unified-workflow-system; shipped in `dork-labs/marketplace` `plugins/flow/`)

## Context

`/pm` and `linear-loop` reach Linear directly with no abstraction, hard-coupling the whole system to one tracker and preventing a second PM tool.

## Decision

Normalize every tracker into one `WorkItem` shape plus a small `PMClient` verb set. In v1, realize it as a single `adapters/linear/` skill (a documented prose contract over Linear MCP + Composio) that owns every tracker-specific string; generic stage skills call the adapter, never tracker fields. The typed TypeScript `PMClient` interface is the P5 server promotion target. The dispatch policy treats fields a thinner tracker lacks (priority, size, project.stateCategory) as neutral.

## Consequences

### Positive

- Agnosticism win with no new infrastructure in v1; a single audit surface for tracker writes.
- Graceful degradation across trackers; a second adapter later proves agnosticism without touching stages.

### Negative

- Adds an indirection layer between stages and the tracker.
- The v1 contract is prose, not compiler-enforced, until the server build.
