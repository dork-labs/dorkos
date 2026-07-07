---
id: 260706-192819
title: Harness-native projection is the delivery mechanism for marketplace plugins
status: accepted
created: 2026-07-06
spec: null
superseded-by: null
---

# 260706-192819. Harness-native projection is the delivery mechanism for marketplace plugins

## Status

Accepted

## Context

A DorkOS marketplace plugin installed at project scope lands in `<repo>/.dork/plugins/<pkg>/`.
Under ADR-0239 ("DorkOS owns the install half, the SDK owns the runtime half"), the claude-code
runtime made those plugins work by passing the install directory to the Claude Agent SDK
`options.plugins` array. That injection was invisible to anything outside a DorkOS-managed session:
run the external `claude` CLI in the same repo and the plugin did not exist: no `/flow:*` commands,
no plugin hooks, no plugin skills, and nothing under `.claude/`.

SDK-only activation therefore created a DorkOS-only fork of reality. The multi-runtime cockpit's
premise is that DorkOS coordinates the same agents a developer already runs; a plugin that works in
the cockpit but not in the terminal breaks that premise and is impossible to reason about from the
filesystem. The Harness Sync engine already projects authored assets to every harness as native
files; installed plugins were the gap.

## Decision

Harness-native projection is the delivery mechanism for marketplace content on every harness,
including claude-code. A project-scoped plugin's portable assets are written as files the harness
reads directly, so the external CLI and DorkOS sessions see exactly the same thing:

- **commands** become generated repo-local wrappers at `.claude/commands/<pkg>/<name>.md` (each
  `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute install dir, marked engine-generated);
- **skills** become namespaced symlinks (`.claude/skills/<pkg>__<name>`, `.agents/skills/<pkg>__<name>`);
- **hooks** merge into the user-owned `.claude/settings.local.json` as matcher groups tagged with an
  explicit ownership sentinel (`_dorkosHarness: "<pkg>"`), touching only the managed entries.

The claude-code runtime stops SDK-injecting project-scoped installs. SDK injection is reserved for
DorkOS-specific runtime concerns (MCP servers, permission wiring, session plumbing). Because DorkOS
sessions run with `settingSources: ['local', 'project', 'user']`, they pick up the projected files
the same way the external CLI does.

Global installs (`~/.dork/plugins`) remain SDK-injected as a transitional exception until global-scope
harness projection lands (DOR-174).

## Consequences

### Positive

- Parity: a project-scoped plugin behaves identically in DorkOS sessions and the external `claude` CLI.
- The filesystem is the source of truth; what an agent sees is inspectable, not hidden in a runtime array.
- Reuses the existing projection, drift-check, and orphan-sweep machinery; uninstall prunes the projected files.

### Negative

- Projections are gitignored machine-local ephemera (they embed absolute paths); command wrapper
  directories carry a self-ignoring `.gitignore` so they never commit.
- Two delivery paths coexist until DOR-174: project-scoped via projection, global via SDK injection.
- Amends ADR-0239: the SDK no longer owns the runtime half for marketplace content, only for
  DorkOS-specific runtime concerns.
