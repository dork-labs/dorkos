---
id: 261122-124821
title: 'One dork: reference for every DorkOS thing: ids for machines, addresses for people'
status: accepted
created: 2026-11-22
spec: conversation-model
superseded-by: null
amends: [261017-211859]
---

# 261122-124821. One `dork:` reference for every DorkOS thing: ids for machines, addresses for people

## Status

Accepted (2026-11-23: PR #4143 merged the decision with the spec's §6 delta as the text of record, DOR-5045 closed).

Proposed (operator ask 2026-11-22, #proj-dork-architecture; design in `research/20261122_dorkos-address-format.md`). The six open calls in that report's §12 were decided on 2026-11-22: Dorian delegated them to DorkOS Code (09:40 CT), which took every pick: (1) the scheme word is `dork:`, and the desktop keeps `dorkos://` with `dorkos://r/` opening a reference; (2) a named conversation is `+name` in display and email; (3) a handle is write-once once an address is issued, and a rename retires the old address, forwards it for 90 days and never reissues it; (4) a public PR body carries `agent`, `chat` (8 characters), `space` and `address`; (5) provenance v2 ships unsigned now, and `sig` comes when the directory publishes keys; (6) a local install mints a space id at first run, beside the install id. Stays Proposed until the PR that carries it merges and the spec's §6 delta becomes the text of record; then `/adr:review` flips it to Accepted (tracked on DOR-5045, under DOR-4966).

**Amends** [261017-211859](261017-211859-a-conversation-is-the-shared-log-a-session-is-private.md): its decision bullet "One address points at one conversation. `{handle}[+{name}]@{space}` renders the canonical `dork://{space}/{handle}/{conversation}`" is retired. The display form stands, with `@{space}` optional inside your own space and the email form following the spec's 2026-10-24 decision (the space in the local part); the canonical form becomes the two `dork:` shapes below. Every other clause of that record stands. The parent's Status carries the matching note.

## Context

DorkOS needs one way to name a space, an agent, a room, a chat, an entry and a computer, so that an inbound email reaches the right conversation, an outward write (a PR body, a Linear comment) says which agent and chat wrote it, a link opens one chat from anywhere, and a room or an agent can be named without naming a chat. Two half-built answers already disagree: the conversation-model spec drafted `dork://{space}/{handle}/{conversation}`, a path of three renamable words, while the Cloud contract already stores a seat's canonical address as `dork:<org-slug>/<handle>` (`packages/cloud-api/src/seats.ts`). Handles are renamed by people, channel slugs are released on archive, and the current signature line carries a hostname, which has already leaked a private network name into a tracker.

## Decision

We will use one scheme, `dork:`, with two shapes. A **reference**, `dork:<kind>:<id>`, names a thing by its permanent opaque id (`space`, `person`, `agent`, `host`, `room`, `entry`, `chat`, `turn`); it is what storage, links, signatures and the work graph use, and it never changes. An **address**, `dork:<space>/<handle>[/<name>]`, names a member or a member's named conversation by its words in an org; it resolves to exactly one reference, is retired rather than edited, and renders as the display form (`owl+launch@acme`), the email form (`owl.acme+launch@<mail domain>`) and the mention forms. A reference never carries a location: the link origin (`<origin>/r/<dork-uri>`), the `space` and `host` fields of a signature, and the domain of an email carry "where". Email and mentions address conversations and agents, never chats; a chat is linked and signed, never addressed.

## Consequences

### Positive

- A link, a signature or an edge minted today still resolves after a rename, an archive, a resume, or a move to another computer.
- The Cloud contract's address form, the work graph's `{kind, id}` reference and the conversation model's display form become one grammar with one parser.
- Signatures carry opaque ids and no hostname, path or email, and `host` is a one-way hash of the install id, never the id itself, because that id is DorkOS's anonymous usage id; so the public-repo rule needs no judgement call.
- Every runtime's session id fits as it is; nothing is re-keyed to adopt the format.

### Negative

- Two shapes to learn and document, and a resolver (`/r/`) plus a directory lookup before a bare reference becomes a click or a name.
- Names must become write-once once an address is issued (the contract's `active | retired` address model), which narrows the local "rename a handle" feature to retire-and-forward.
- Chat references inherit the runtime's one re-key on a brand-new chat; the resolver must follow the redirect and the re-key must be recorded durably before signatures rely on it.
- Channels get no email address until channel slugs have tombstones.

## Alternatives considered

- **Keep `dork://{space}/{handle}/{conversation}` as canonical.** Rejected: every segment can change, a shared room has no owner for the path, and it cannot name a chat, a host or an entry.
- **One flat opaque id with a lookup table.** Rejected: runtime and space-server ids would each need a second DorkOS id, a reader cannot tell a chat from a room without asking, and there is no human form.
