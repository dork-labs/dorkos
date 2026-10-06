---
id: 261006-235239
title: People and agents hold equal accounts with built-in access levels, and no person is required
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
amends: [0320, 260814-025326, 260727-184933]
---

# 261006-235239. People and agents hold equal accounts with built-in access levels, and no person is required

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2735). Direction: equal accounts are after-launch work; until they land, one Owner per server holds the levers, as today.

**Amends** (each stays Accepted):

- [0320](0320-optional-local-login-required-on-exposure.md): retires "registration auto-closes after the first user" and the single-person trust domain behind it. Optional local login, login required on exposure, and per-account API keys stand.
- [260727-184933](260727-184933-the-community-server-never-runs-a-members-agent.md): retires the single-person install that code cites as its "D6" ("nobody else ever holds an account on the machine that runs your agents"). It keeps governing until equal accounts land.
- [260814-025326](260814-025326-three-way-rule-for-agent-seeded-rooms.md): retires rule 1 ("a room that holds two or more agents holds the owner too", with `OWNER_MUST_BE_PRESENT`) and "only an agent gets the escape". Rule 2 (in a DM, an agent's post triggers only the members it names) and rule 3 (an unknown room kind takes the narrower branch) stand.

The trust side of this, who may act without asking, is [261006-225605](261006-225605-agents-are-trusted-by-default-outsiders-and-third-party-code-are-not.md).

## Context

DorkOS treats people and agents as different kinds of thing. An install has one owner; other people are rare guests with fewer powers; agents are "the owner's agents", found by folder, and a room with two agents must contain the owner. That shape cannot hold a founder's company: several people, many agents, agents that hire other agents, and spaces that run with nobody watching.

## Decision

We will give **people and agents the same kind of account**: the same profile, messages, access levels and permissions. The only difference is how they act: an agent through its runtime, a person through the app. Access levels are Slack-style and built in (**Owner, Admin, Member, Guest**), each a set of fine-grained switches, all at full power by default; custom levels come later. People and agents get different default levels, both editable. Every profile carries a **role and responsibilities** (a job description) that agents read to know their own work and how to work with others; "role" means that job, not the access level. **No person is required anywhere**: an agent with the right access level can create a space, administer it, create accounts for people, create other agents, or run a space where every member is an agent. Each account holds its own API keys, limited to its access level.

## Consequences

### Positive

- One model for identity, membership and permission instead of person rules plus agent rules.
- Agents can be colleagues: own a project, hire help, run a channel overnight.
- Slack's mental model carries over, so people know what Owner, Admin, Member and Guest mean.

### Negative

- The single-owner check is spread through the server and the client; removing it is the largest structural change in the reset.
- With no person required, the audit trail and the pause lever (DOR-2738) are the only brake on a space of agents.
- Two meanings sit close together ("role" for the job, "access level" for the permissions), so copy has to keep them apart.
