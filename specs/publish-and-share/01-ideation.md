---
slug: publish-and-share
number: 261126-015502
created: 2026-11-25
status: specified
---

# Publish and share

**Slug:** publish-and-share
**Linear:** DOR-5302. Carries DOR-4841, DOR-4842 and DOR-4843, each with a verdict in the spec.
**Decision:** ADR [`261125-183122`](../../decisions/261125-183122-a-published-page-is-a-saved-copy-on-an-always-on-home.md), which amends ADRs `261015-042933`, `261124-194115` and `261125-113808`
**Roadmap:** `meta/ROADMAP.md` item 19. Needs parts of items 1 and 2 (publishing is capabilities, and a page gets a reference kind) and item 13 (a person's DorkOS in the cloud as an always-on home). A DorkOS server a person runs needs neither item 13 nor any hosted service. Runs beside items 14 to 18.
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

Agents in DorkOS make docs and mini apps, and write folders of web files such as a deck or a report. Today all of it stays inside the DorkOS that made it. The canvas shows a doc to a room's members or to the person in their own chat, and nothing serves it to anyone outside. A founder cannot send a customer a link to a calculator an agent built, or a deck an agent wrote.

ADR `261125-183122` settles the direction: to publish is to save a copy, with a link, on a home a link can always reach. The copy is served from a web address apart from the app, each page on an origin of its own, in a sandbox, holding none of its publisher's power. It is private until its owner shares it. An agent may publish; an agent needs a yes to widen who can open a page. It is built in three stages, and this spec builds the first: docs, mini apps that run fully in the browser, and plain web files an agent wrote.

## What is built today

| Piece                                               | State                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A store of published pages, or their versions       | None                                                                                                   |
| A web address apart from the app on a DorkOS server | None. Only the frozen space server has a separate address for its downloads                            |
| A `page` reference kind                             | None. `dork-ref.ts` has ten kinds                                                                      |
| Capabilities to publish, share or take down         | None                                                                                                   |
| A mini app's page half with no host app             | None. Its screens run in a sandboxed frame inside the app and reach DorkOS through the frame's bridge  |
| Serving an agent's web files                        | To the person alone, through a signed 30-minute local link, in an opaque-origin sandbox                |
| The refusal of secret files                         | Built: the protected-files list and the secret-name scan, used by the local file routes and the canvas |
| A "do not index" header                             | None anywhere in the server                                                                            |
| A content address in `packages/cloud-api`           | None. A person's DorkOS in the cloud answers on its one assigned address                               |

## What the spec settles

- **The invariants** for all three stages, each with how it is checked.
- **The store**: pages, versions and files kept by content address; the page's id, kind, owner, publisher, audience and pin; the `page` reference kind.
- **What a copy holds** for a doc, a browser-only mini app and a folder of web files; the refusal of protected files; the file list shown before the copy; the limits.
- **Serving apart**: the content host, an origin for each page, the sandbox and every header, the one cookie, "do not index", what a taken-down or unknown link answers, and how the owner opens a private page.
- **Whose it is, and reporting**: a fixed line and a header on every answer saying it is published with DorkOS and is not DorkOS itself, and a "Report this page" route that reaches the owner.
- **The audiences and the yes**: only the owner, then anyone with the link and a password, then anyone with the link, which opens only once "Report this page" is built; what widening is; the card; a turn that read words from outside; a new version of a shared page.
- **The capabilities**, with a section the API lead can read alone.
- **A browser-only mini app as a page**: the manifest line, the page runtime and its storage, and what publishing refuses.
- **Where it runs**, by one rule: an install with the content host setting serves its own pages; else a Mac with publishing turned on pushes the copy to its owner's DorkOS in the cloud (a contract change first); else publishing says there is no home. And a home that sleeps.
- **Verdicts** on DOR-4841, DOR-4842 and DOR-4843, and the build steps for stage 1.

## What is left to later parts

- Stage 2, a mini app's server half in a sealed box, and stage 3, a named grant that lets a page reach its publisher. This spec says only what stage 1 leaves room for.
- Named people and a space's members as audiences (they need member checks and team spaces), and listing in public with its abuse controls.
- A page made from a team space's doc, taking a copy ("Open in your DorkOS"), anything of the viewer's that uses the viewer's own account, comments on a page, a web address of one's own for a page, and moving a page to another home.
- An agent manager's yes on a card. In stage 1 a person answers.
- Prices and plans.
