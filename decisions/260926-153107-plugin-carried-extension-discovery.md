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
- Precedence and approval are unchanged: a local record never takes over a core or approved id, and every non-core extension needs the person's one-time approval.
- Uninstalling the plugin disables its extensions and clears their approval.

## Consequences

- Positive: the documented "plugin carries an extension" shape works end to end; no copy step that can drift.
- Negative: two more directory scans per discovery pass; a duplicate id across plugins resolves by sorted name with a warning.
