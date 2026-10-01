---
slug: doc-channel
id: 261001-184500
created: 2026-10-01
status: specified
linearIssue: DOR-2665
---

# Canvas pages and agents share a document channel

## Intent

Dorian wants events to travel both ways between a canvas document and an agent,
without a page choosing its own authority or starting a separate conversation the
person never sees. The LifeOS dashboard is the first consumer: a checkbox changes
the markdown source of truth, LifeOS hears about it, and its reply reaches the
dashboard without replacing a draft comment.

## Source and design lineage

Adapted from `/Users/doriancollier/Keep/Obsidian Repo/0-System/dorkos-doc-channel-spec.md`,
including Revision 2, and the handoff dated 2026-10-01. Revision 2 supersedes the
original phase table: v1 core/frames/widgets; v1.1 MCP apps/editors/presence; v2
standalone/bound widgets/grant controls.

The external source remains untouched. Its main design choices are retained:

- One durable server log and router, keyed by document ID.
- Content-specific transports normalize into one ingest service.
- The page emits `{v:1,id,type,payload,coalesceKey?,ts}`; the host supplies identity.
- Declarations propose routes; independent grants authorize them.
- App events remain untrusted data and never become operator messages.
- Busy targets hold work; ingestion and completed work have separate receipts.
- Live state belongs beside content and never bypasses the content edit lock.
- A narrow server checkbox operation may replace the dashboard's custom writer
  later; standalone authentication ships last.

## Reference consumer

Read dashboard `DESIGN.md` through v1.4, `server/serve.py`, and
`app/lib/channel.js`. It supports task toggles, comments, opening notes and flushing
notifications. Its primary delivery is now the session containing the dashboard;
relay is a fallback. Busy delivery retries, comment retries and acknowledgement
resends already exist, so “send once, no retry” is stale.

The SDK prepares UUID envelopes but drops the envelope ID when posting to v0
write routes. Its local `recorded` event reports a successful HTTP request, not
proof that DorkOS processed that ID. v1 must preserve IDs end to end. Swapping one
transport file replaces notification plumbing; it does not automatically move
markdown writes, comment storage, note opening or rebuilds into DorkOS.

## Validation and corrections

Current-source evidence, ticket triage and remaining proof obligations are in
[04-source-audit.md](./04-source-audit.md). The implementation design is in
[02-specification.md](./02-specification.md).

Major corrections: scope streams support SSE as well as WebSockets; relay's
normal agent path resumes its own conversation rather than an arbitrary open
session; a page-visible nonce cannot authenticate a shim against the page itself;
the accepted no-turn-on-canvas-change ADR needs an explicit narrow amendment;
and generic toggle cancellation is unsafe without a validated baseline.

## Scope decision

Specify DOR-2665 locally. Keep DOR-2660–2664 and DOR-2666 as independent work,
with explicit dependencies and verification requirements. The initial intent preparation made no production or tracker change. The human
subsequently authorized full phased delivery through verified merge and Flow DONE;
current run authority and checkpoints are in 04-implementation.md.
