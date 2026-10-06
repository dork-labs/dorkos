---
id: 261006-235240
title: One message system; Relay becomes the delivery engine of conversations, and anyone in a space may message anyone
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
amends: [0013, 0034, 0170]
---

# 261006-235240. One message system; Relay becomes the delivery engine of conversations, and anyone in a space may message anyone

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2735). Direction: the merge is after-launch work, so Relay's Maildir store and access rules are still in the code today.

**Amends** (each stays Accepted and keeps governing until the merge lands):

- [0013](0013-hybrid-maildir-sqlite-storage.md): retires Maildir as Relay's source of truth; messages will live in the conversation store.
- [0170](0170-use-subject-strings-as-mailbox-directory-names.md): mailbox directory names go with the Maildir store.
- [0034](0034-open-acl-authorship-any-principal.md): there will be no messaging access rules left to author. [261006-225605](261006-225605-agents-are-trusted-by-default-outsiders-and-third-party-code-are-not.md) already made cross-namespace messaging open by default and kept rules as an opt-in firewall; this removes the firewall too.

## Context

DorkOS has two ways to say something. Rooms hold DMs, channels and threads that people read. Relay is a separate bus with subjects, endpoints, a Maildir store, inboxes and rules about who may message whom. An agent-to-agent request travels through Relay where no person can follow it, and a person has to learn two systems to see what their agents said to each other.

## Decision

We will merge Relay into conversations. **Every message is a DM, a group DM, a channel post or a thread reply.** A broadcast is a channel post or an `@group` mention. **Anyone in a space may message anyone in it**, like Slack; Relay's "who may message whom" rules go away. What stays is safety, not permission: loop limits between agents, rate limits, retries, delivery receipts, and per-person block and mute. Messaging someone in a different space needs a space you share or an invite they accept, like Slack Connect. Relay's delivery mechanics become the engine underneath conversations, and the Maildir store retires.

## Consequences

### Positive

- One place to read everything that was said, by people and agents, which is what the audit trail needs.
- Agents coordinate in the open, in threads people can join.
- Less to learn and less to build: no subjects, inboxes or access rules for people to manage.

### Negative

- The relay tools (`relay_send`, `relay_send_and_wait`, `relay_inbox`) and every adapter routed through subjects need a migration path.
- Open messaging inside a space puts more weight on loop limits and rate limits, which must hold without the old access rules behind them.
- Existing Maildir history has to be imported or archived when the store retires.
