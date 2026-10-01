---
id: 261001-185211
title: Document live state is independent of editable content
status: proposed
created: 2026-10-01
spec: doc-channel
superseded-by: null
---

# 261001-185211. Document live state is independent of editable content

## Status

Proposed (extracted from [doc-channel](../specs/doc-channel/02-specification.md)).

## Context

An agent currently changes a canvas document by replacing its content, which must
respect the person's edit lock. Interactive dashboards need small live updates
while a comment or document draft remains open. Frames, native widgets and MCP
apps also need one state shape that can be restored after missed stream events.

## Decision

We will persist a bounded JSON state object beside document content, with its
own revision and a document-event replay cursor. Authorized agent operations
patch it atomically using validated JSON Pointer paths and expected revisions.
Live transport notifications supplement the durable log and snapshot; they are
not the only recovery mechanism. State updates never clear content locks,
replace drafts or enter upstream turn routing.

## Consequences

### Positive

- Agent updates can reach a dashboard while the person continues editing.
- Frames, widgets and MCP apps can share one downstream/recovery protocol.
- Existing content edit protection remains intact.

### Negative

- Clients must track state revisions, document cursors and scope cursors separately.
- Introduces state size limits, patch validation and explicit retention resets.
- Persisting app state does not move its source files or application writes into
  DorkOS; those still need independent confined write operations.
