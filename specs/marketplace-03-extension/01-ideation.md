---
slug: marketplace-03-extension
number: 226
created: 2026-04-06
status: ideation
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 3
depends-on: [marketplace-01-foundation, marketplace-02-install]
linear-issue: null
tags: [marketplace, ui, extension, browse, search]
---

# Marketplace 03: Marketplace Extension (Browse UI)

**Slug:** marketplace-03-extension
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 3 of 5

---

## Source Material

- **Parent ideation:** [`specs/dorkos-marketplace/01-ideation.md`](../dorkos-marketplace/01-ideation.md)
- **Foundation spec:** [`specs/marketplace-01-foundation/02-specification.md`](../marketplace-01-foundation/02-specification.md)
- **Install spec:** [`specs/marketplace-02-install/02-specification.md`](../marketplace-02-install/02-specification.md)

This spec depends on **both** prior specs being implemented. The foundation provides the schemas; the install spec provides the HTTP API this UI will call.

---

## Scope of This Spec

Build the in-app marketplace browsing experience. This spec ships a built-in DorkOS Extension (dogfooding the extension system) that surfaces "Dork Hub" — the marketplace browse UI — inside the DorkOS client.

### In Scope

1. **`@dorkos-builtin/marketplace` extension** — Built-in extension shipped with DorkOS
2. **`sidebar.tabs` registration** — "Dork Hub" tab in the main sidebar
3. **Browse view** — Grid of packages with type filters (Agents | Plugins | Skills | Adapters | All)
4. **Featured section** — Hero rail at the top showing featured Agents (Vision 1)
5. **Search** — Client-side filter by name, description, tags
6. **Filter UI** — Type, category, layers (multi-select)
7. **Package detail view** — Description, README, manifest, permission preview, install button
8. **Install button + flow** — Calls `POST /api/marketplace/packages/:name/install` with confirmation modal
9. **Installed packages list** — "Manage Installed" view with uninstall + update actions
10. **Marketplace source management UI** — Add/remove marketplace sources
11. **TemplatePicker integration** — Existing CreateAgentDialog reads marketplace via `?type=agent` filter
12. **Empty/loading/error states** — All states handled gracefully

### Out of Scope

- Server-side install API (Spec 02)
- Web marketplace page on dorkos.ai (Spec 04)
- Public registry / seed packages (Spec 04)
- MCP server (Spec 05)
- Live preview / try-before-install (deferred)
- Reviews / ratings UI (deferred)

---

## Resolved Decisions

| #   | Decision                        | Choice                                                                                 | Rationale                                                               |
| --- | ------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Marketplace name                | **Dork Hub**                                                                           | Short, distinctive, on-brand. Mirrors "GitHub for AI agents" framing.   |
| 2   | Sidebar position                | New `sidebar.tabs` entry, between "Tasks" and "Settings"                               | Discoverable but not intrusive. Doesn't displace core navigation.       |
| 3   | Default sort order              | Featured first, then alphabetical                                                      | Featured curation drives early discovery; alphabetical is predictable.  |
| 4   | Filter UX                       | Tab strip (type) + search box + collapsible filter sidebar (category/layers/tags)      | Familiar pattern. Doesn't require complex state management.             |
| 5   | Detail view layout              | Sheet (slide-in from right) with sections: Header → Description → Permission → Install | Doesn't navigate away from the browse list. Preserves browsing context. |
| 6   | Confirmation modal              | Dialog with permission preview + cancel/install buttons                                | Trust by design. Honest about what will happen.                         |
| 7   | Install progress UI             | Inline toast with progress bar + completion state                                      | Doesn't block the rest of the UI.                                       |
| 8   | Built-in extension vs hardcoded | Built-in extension                                                                     | Dogfoods the extension system. Extension can be updated independently.  |
| 9   | Featured agents rail            | Top of browse view, horizontal scroll, max 6 cards visible                             | Drives Agent App Store framing. Featured curation is editorial.         |
| 10  | TemplatePicker integration      | Existing component reads marketplace via filter; no replacement                        | Minimal disruption to existing onboarding.                              |

---

## Acceptance Criteria

- [ ] "Dork Hub" tab appears in sidebar after install
- [ ] Browse view loads marketplace packages from `/api/marketplace/packages`
- [ ] Featured Agents rail displays at top
- [ ] Type filter tabs work (All | Agents | Plugins | Skills | Adapters)
- [ ] Search filters results in real-time
- [ ] Category and layer filters work
- [ ] Detail sheet shows package metadata, README, permission preview
- [ ] Install button triggers confirmation modal
- [ ] Install completes and updates installed-list view
- [ ] Uninstall works from "Manage Installed" view
- [ ] Update notifications appear when available
- [ ] Marketplace source management UI works
- [ ] TemplatePicker shows marketplace agent templates alongside built-ins
- [ ] All states handled (empty, loading, error, offline)
- [ ] Tests cover all major user flows
- [ ] Built-in extension auto-installed on first run
