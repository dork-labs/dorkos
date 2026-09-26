---
id: 260926-153107
title: Extensions that ship inside an installed plugin are discovered and gated like any other extension
status: draft
created: 2026-09-26
spec: claude-account-ui
superseded-by: null
---

# 260926-153107. Extensions that ship inside an installed plugin are discovered and gated like any other extension

## Status

Draft (auto-extracted from spec: claude-account-ui)

## Context

A marketplace plugin may carry extensions (`.dork/extensions/<id>/`), and installing one compiles them and calls `enable()`. But discovery scans only `<dorkHome>/extensions/` and `<cwd>/.dork/extensions/`, so `enable()` finds no record and the extension never runs. The Flow extension ships this way.

## Decision

- Discovery also scans `<dorkHome>/plugins/*/.dork/extensions/*` (origin `global`) and `<cwd>/.dork/plugins/*/.dork/extensions/*` (origin `local`).
- An approval is tied to the extension's **source**, not just its id (S4 task 6.1): its own folder for a standalone extension, or the plugin's name plus the folder inside it for a plugin-carried one. Sources live in the new operator-only `extensions.approvedSources` map.
- A different plugin (or folder) that claims an already-approved id needs fresh approval. An update from the same plugin keeps its approval.
- A legacy approval with no recorded source counts as unapproved, so the person approves it once more.
- A local record still never takes over a core id, and every non-core extension needs the person's approval before it runs.
- Uninstalling the plugin disables its extensions and clears their approval.

## Consequences

- Positive: the documented "plugin carries an extension" shape works end to end, with no copy step that can drift. An approval cannot be borrowed by another plugin that ships the same id.
- Negative: two more directory scans per discovery pass; a duplicate id across plugins resolves by sorted name with a warning; every existing approval is asked again once, because legacy approvals have no source.
