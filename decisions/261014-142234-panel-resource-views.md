---
id: 261014-142234
title: Panel tabs represent resource views and share computer control ownership
status: accepted
created: 2026-10-14
spec: computer-panel-resources
superseded-by: null
---

# Panel resource views and computer control ownership

## Status

Accepted. The operator selected relevant tabs plus a menu after comparing a view switcher and icon rail.

## Context

The right panel has seven category tabs, with second tab rows inside Browser and Terminal. Adding a computer to that structure worsens overflow. A computer presenter also owns its own frame loop and takeover lease, so mounting it twice can duplicate capture and create competing input owners. Server canvas documents and PTYs already have durable identities and survive view changes.

## Decision

The panel owns one tab row of relevant defaults and concrete resource views. Browser pages, documents and shells use their durable resource IDs, qualified by the session/room. A bounded client preference stores which views are open; closing a view is local, while stopping a shell or removing a shared document remains an explicitly named action in the menu. Route, capability and mini-app placement predicates still decide eligibility.

Document closure preferences live in the same client store as document identities. Settling a temporary document ID or carrying a draft into its canonical conversation transfers the closure in the same state update. The document owner's session and directory qualify its closure independently of ambient navigation. These transitions preserve local choices without removing a server document.

Computer capture and input ownership live in a transport-scoped entity session shared by panel, PiP and standalone presenters. PiP pins computer ID, generation and agent/cwd identity independently of ambient chat navigation. Each presenter has a distinct input identity. Transfer, close, blur and phone minimization synchronously revoke local control and return the lease; observe never acquires control. A replacement generation retires the previous capture/input lifetime. Reopening an old view cannot resurrect an old control session.

## Consequences

### Positive

- One resource row preserves content height and reaches overflow through the menu.
- Closing a view does not destroy work or remove a document from another person's table.
- One capture loop and exclusive input ownership cover overlapping presentation transitions.
- Existing standalone previews keep their own chrome; server resource contracts do not change.

### Negative

- The current terminal owner stays mounted while hidden within its session/cwd scope; hidden instances must never focus.
- View preferences need bounds and validation and must reconcile external open requests.
- A transferred computer requires an explicit takeover again, trading one click for unambiguous input ownership.

## References

- `specs/computer-panel-resources/02-specification.md`, DOR-2916.
- ADR `260708-185518` keeps the durable multi-document canvas model.
- The existing PiP descriptor and phone sheet/mini-bar contracts remain in force.

Pending document receipts retain captured ownership across navigation and canonical handoff. Their cleanup is per request; settlement preserves local closed-view choices without inserting an old document into the currently visible conversation.
