---
id: 260925-050657
title: An agent's runtime, model or effort changed outside DorkOS re-asks for the schedules that follow it
status: accepted
created: 2026-09-25
spec: null
superseded-by: null
amends: [260924-213416]
---

# 260925-050657. An agent's runtime, model or effort changed outside DorkOS re-asks for the schedules that follow it

## Status

Accepted. Amends 260924-213416: its negative consequence "a hand edit of `.dork/agent.json` … is not gated" now reads "is not blocked, and is re-asked". Everything else in it stands, including that the approval key holds the schedule's own values, never resolved ones.

## Context

A schedule that leaves its runtime, model or effort unset runs on its agent's, and its approval records "follow the agent" (260924-213416). DOR-2328 put every DorkOS door that changes those three for an agent behind a person. The agent's `.dork/agent.json` stays outside that: it is the person's file (the DOR-2306 line), and DorkOS cannot tell the person's editor from an agent's shell writing the same bytes. So an agent that edited its own file moved its approved schedules with nothing recorded anywhere (DOR-2337).

## Decision

We will observe the three fields the way the permission history observes permissions, with one shared observer core (`OutsideChangeObserver`), and not police the disk. A change nobody made through DorkOS is recorded in Activity as "Changed outside DorkOS", old → new. Every approved schedule that follows the agent for a changed field waits for a person again, with a fixed sentence and the change old → new on its card (`approvalChanges` entries with `via: 'agent'`, kept in `pulse_schedules.followed_agent_changes`). It is checked before every scheduled fire, after every five-minute reconciler pass, and once at boot. DorkOS's own writes (the app, the routes, an approved `update_agent_execution`) run through the observer so they are never taken for outside changes, and an outside edit made before one of them is observed first so the write cannot carry it through unseen. Nothing is ever switched on: changing the agent back leaves the schedule waiting, and only a person approves it.

## Consequences

### Positive

- An agent that changes what it runs on by editing its file is visible, and cannot move approved work without a person seeing old → new.
- The permission observer and this one share the concurrency and record-keeping that is easy to get wrong.

### Negative

- A person who hand-edits their agent's file is asked again too: the file cannot say who wrote it.
- A schedule that names its own runtime but follows the agent's model is parked by a model change even when the agent's model would not apply on that runtime. Over-asking was chosen over resolving the ladder here.
- An edit made in the milliseconds between the fire's check and its own read of the manifest runs once, and is caught by the next check.
- An agent with a shell that edits both its manifest and DorkOS's last-seen record can hide a change; the record is a speed bump, as the permission record is.
