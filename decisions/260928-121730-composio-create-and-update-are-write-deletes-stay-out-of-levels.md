---
id: 260928-121730
title: Composio create and update actions are write; deletes stay out of every level
status: accepted
created: 2026-09-28
spec: connection-app-details
superseded-by: null
amends: null
---

# 260928-121730. Composio create and update actions are write; deletes stay out of every level

## Status

Accepted (owner decision A on DOR-2466, 2026-09-28).

## Context

The access levels read one rule (`levelIncludes`): "Read" grants `read` actions, "Read and write" adds `write`, and no level ever grants `destructive`, which is allowed one action at a time. Composio's classifier (`classify` in `packages/connector-providers/src/composio/sdk-client.ts`) only ever returned `read` or `destructive`, so every Composio app offered "Read" alone, and sending an email or adding an event meant picking exact actions.

Composio labels every action with at least one of four verdict tags, which it enforces in its own CI and documents in its session guide: `readOnlyHint` (changes nothing), `createHint` (creates something, "such as sending an email or opening an issue"), `updateHint` (changes something in place) and `destructiveHint` ("irreversibly removes, cancels or revokes data"; an irreversible update carries `updateHint` too). `idempotentHint` and `openWorldHint` are partial MCP hints and prove nothing. The earlier rule predates `createHint`/`updateHint`, and MCP's own default ("no `destructiveHint` means destructive") is why a missing tag can never be read as safe.

## Decision

We classify a Composio action as `write` only on a positive create or update verdict that nothing contradicts: at least one of `createHint`/`updateHint`, and every tag in the known set `createHint`, `updateHint`, `idempotentHint`, `openWorldHint`, `important`. `destructiveHint`, `readOnlyHint` or any tag DorkOS does not know keeps it `destructive`, and so does an action with no verdict at all. The `read` rule is unchanged. Deletes stay out of both levels because Composio marks them `destructiveHint`, which our rule never lets through.

Classification is not rewritten on stored data. Operation revisions are immutable and their identity includes the classification, so the next discovery records a send action as a new `write` revision beside the old `destructive` one. Nobody is moved onto it: a "Read" grant keeps exactly its read actions, and an agent that picked the old destructive send action exactly keeps it, still behind per-action approval, until the person next changes that agent's access (the old revision shows as no longer offered). On the hosted DorkOS account path the same client classifies, and the hosted store already retires the old revision and its grant on a reclassification, so access there can only shrink until the person chooses again.

## Consequences

### Positive

- Gmail, Calendar, GitHub and other Composio apps offer "Read and write": send, create and edit, never delete.
- The rule reads only what Composio asserts; an unknown future tag or a missing verdict still lands in the strictest tier.
- Both sides (this computer and the hosted account path) classify through one function, so they cannot disagree.

### Negative

- We trust Composio's verdict. Sending an email cannot be undone, yet Composio calls it `createHint`, so "Read and write" lets an agent send; the owner chose this on purpose.
- If a pinned toolkit version still lists tools without `createHint`/`updateHint`, those tools stay `destructive` and the app keeps offering "Read" only until Composio re-syncs it.
- Anyone who picked Composio send or create actions one by one sees them as no longer offered and chooses again the next time they change that agent's access.
