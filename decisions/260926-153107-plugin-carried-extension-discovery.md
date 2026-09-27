---
id: 260926-153107
title: Extensions that ship inside an installed plugin are discovered and gated like any other extension
status: accepted
created: 2026-09-26
spec: claude-account-ui
superseded-by: null
---

# 260926-153107. Extensions that ship inside an installed plugin are discovered and gated like any other extension

## Status

Accepted (auto-extracted from spec: claude-account-ui)

## Context

A marketplace plugin may carry extensions (`.dork/extensions/<id>/`), and installing one compiles them and calls `enable()`. But discovery scans only `<dorkHome>/extensions/` and `<cwd>/.dork/extensions/`, so `enable()` finds no record and the extension never runs. The Flow extension ships this way.

## Decision

- Discovery also scans `<dorkHome>/plugins/*/.dork/extensions/*` (origin `global`) and `<cwd>/.dork/plugins/*/.dork/extensions/*` (origin `local`).
- An approval is tied to the extension's **source**, not just its id (S4 task 6.1, DOR-2383, commit ed8325c3): its own folder for a standalone extension, or the plugin's name plus the folder inside it for a plugin-carried one. Sources live in the new operator-only `extensions.approvedSources` map (`id → { path, plugin? }`), beside `approvedToRun`.
- A different plugin (or folder) that claims an already-approved id needs fresh approval. An update from the same plugin keeps its approval: the update's remove-then-install must not forget the approval (at ed8325c3 it does, because the replace step runs the uninstall side effects; task 4.1 of `claude-account-ui` fixes that unless 6.1 does first).
- An approval with no recorded source counts as unapproved. Approvals given before sources existed are bound, on the first discovery after the 0.86.0 migration, to the direct install at `<dorkHome>/extensions/<id>` only; a copy of that id found only inside a plugin or a project asks again.
- A project copy (direct or carried by a plugin) never takes over a core id or an id approved for another copy, and every non-core extension needs the person's approval before it runs.
- Uninstalling the plugin disables its extensions and clears their approval.

## Consequences

- Positive: the documented "plugin carries an extension" shape works end to end, with no copy step that can drift. An approval cannot be borrowed by another plugin that ships the same id.
- Negative: two more directory scans per discovery pass; a duplicate id across plugins resolves by sorted name with a warning; an older approval keeps working only for the direct install it binds to; any other copy of that id is asked again.
