---
slug: community-host-operator-api
number: 260923-121148
created: 2026-09-23
status: ideation
linear-issue: DOR-2243
project: Cloud-Hosted Communities
---

# Community host-operator API

## Brief

A Community host can now serve many communities (DOR-2171, DOR-2175). Running a host with many communities on it takes a few general tools the server does not have yet: a way for a program to call the host routes, limits the host can set per community, a way to bring a community over from another host, readable short web addresses, sign-in through a company's own identity service, and entry points in the DorkOS app. Tracker: DOR-2243. The discussion that led to this brief lives in the tracker; this file keeps only what the specification needs.

Every capability must earn its place for **any** self-hosting host operator. A hosted service such as DorkOS Cloud may be one host operator. Nothing here is a hook for one operator, and the Community server keeps working with every DorkOS host blocked.

## The six capabilities

| Id  | Capability                                                                           | Phase |
| --- | ------------------------------------------------------------------------------------ | ----- |
| P1  | Scoped, revocable machine credential for host routes                                 | 1     |
| P2  | Per-community limits and a host usage read                                           | 1     |
| —   | Host hold, and host-started deletion after a noticed hold                            | 2     |
| P6  | Short names in the path (`/<name>`)                                                  | 3     |
| P3  | Import an owner export on another host                                               | 4     |
| P5  | "Start a community" and "Move a community" in the DorkOS app                         | 5     |
| P4  | Generic OpenID Connect sign-in, plus host-set terms, privacy, and report-abuse links | 6     |

The hold, host-started deletion, and host links were added while specifying, from the requirements review on DOR-2243; each is justified for any self-hoster in the specification.

## Decisions already made by the operator

- 100 active agents per person per community. There is no community-wide agent cap.
- Raising the agent limit for one person, on request, needs a per-member override.
- Message history is never limited.
- The member count limit is set by the host, per community.
- Addresses are path short names (`host/<name>`). Subdomains may come later and are out of scope.
- A cap is not a rate limit. The agent cap's `429 RATE_LIMITED` answer is wrong and gets its own error.

## Assumptions carried into the specification

- The tenancy contract's split between host authority and content authority stands. A machine credential is host authority and nothing more.
- The owner export format written by `routes/exports.ts` today (manifest version 1) is the input for import. Anything it does not carry cannot be restored from it.
- Credentials are bound to the host that issued them. Installations and agents always pair again after a move.
- Names are never identity. The immutable community UUID stays the only identity in every credential, link the server mints, and stored connection.

## Prior decisions this work reopens

- The tenancy contract (`260920-192429`) excluded vanity slugs. Only the path form is reopened here, as a mutable alias.
- The tenancy and administration contracts excluded moving a community between hosts. Import reopens it for whole communities only. Moving one membership between hosts stays out of scope.
- The administration contract kept content-derived counts out of the host list. The usage read adds exactly three aggregates the host needs to enforce its own limits, and nothing else.

## Next step

`02-specification.md` in this folder.
