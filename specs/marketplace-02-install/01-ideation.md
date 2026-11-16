---
slug: marketplace-02-install
number: 225
created: 2026-04-06
status: ideation
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 2
depends-on: [marketplace-01-foundation]
linear-issue: null
tags: [marketplace, install, cli, transactions, rollback]
---

# Marketplace 02: Install

**Slug:** marketplace-02-install
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 2 of 5 — depends on `marketplace-01-foundation`

---

## Source Material

This is the SECOND of 5 sequential specs implementing the DorkOS Marketplace. Read the parent ideation first for full vision and context:

- **Parent ideation:** [`specs/dorkos-marketplace/01-ideation.md`](../dorkos-marketplace/01-ideation.md)
- **Foundation spec (must ship first):** [`specs/marketplace-01-foundation/02-specification.md`](../marketplace-01-foundation/02-specification.md)
- **Source brief:** [`research/20260331_marketplace_project_brief.md`](../../research/20260331_marketplace_project_brief.md)

---

## Scope of This Spec

This spec produces the **install machinery** for the DorkOS Marketplace. After this ships, a user can run `dorkos install <package>` and end up with a working installation. The marketplace foundation (schemas, parser, validator) is consumed; the UI and registry come later.

### In Scope

1. **`dorkos install` CLI command** — Single command, three install flows (plugin/agent/skill-pack/adapter)
2. **Three install flows:**
   - **Plugin** — Compile extensions, place skills/hooks/commands, register MCP servers
   - **Agent** — Clone template, scaffold `.dork/agent.json`, install bundled tasks/extensions, register in mesh
   - **Skill pack** — Place SKILL.md files in destination directories
   - **Adapter** — Add to `.dork/relay/adapters.json`, prompt for credentials
3. **Atomic transactions** — All-or-nothing installs with rollback on failure
4. **Permission preview** — Show what a package will do before install
5. **Uninstall flow** — Clean removal with optional `--purge` for data
6. **Update flow** — Detect newer versions, advisory notification, manual upgrade
7. **Local cache** — `~/.dork/cache/marketplace/` for cloned packages with TTL
8. **Marketplace add/remove** — Manage which marketplaces DorkOS reads from
9. **Conflict detection** — Warn when packages collide on slot/skill/task names
10. **Server-side install API** — HTTP endpoints that the eventual UI (spec 03) will call

### Out of Scope

- Marketplace browse/search UI (Spec 03)
- TemplatePicker integration (Spec 03)
- Web marketplace page (Spec 04)
- Public registry repo (Spec 04)
- Seed packages (Spec 04)
- MCP server (Spec 05)
- Personal marketplace publishing (Spec 05)
- Live preview / try-before-install (deferred)
- Verified publisher signatures (deferred)

---

## Resolved Decisions

| #   | Decision                    | Choice                                                                                         | Rationale                                                                         |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Plugin install location     | Both global (`~/.dork/plugins/{name}/`) and project-local (`.dork/plugins/{name}/`)            | Mirrors extension/agent file-first pattern. Project overrides global on conflict. |
| 2   | Atomic transaction strategy | Backup branch + temp staging directory + atomic rename                                         | Extends template-downloader.ts pattern. Proven, simple.                           |
| 3   | Permission preview          | Always show on first install. Skipped on update if `.claude-plugin/plugin.json` unchanged.     | Trust by design. Honest defaults.                                                 |
| 4   | Update strategy             | Advisory notify only. Never auto-update.                                                       | User control. Marketplace items are not background dependencies.                  |
| 5   | Uninstall data preservation | Preserve secrets/data by default. `--purge` flag for full removal.                             | Safety. Don't surprise users with data loss.                                      |
| 6   | Conflict resolution         | Detect on install. Warn user. Last-installed wins for slots; namespace prefix for skill names. | Match Claude Code pattern with explicit warning.                                  |
| 7   | Cache TTL                   | 1 hour for marketplace.json. Content-addressable (commit SHA) for cloned package contents.     | Balances freshness with offline reliability.                                      |
| 8   | Marketplace authentication  | Use existing `gh auth token` / `GITHUB_TOKEN` (already wired in template-downloader.ts)        | No new auth surface. Works with private repos.                                    |
| 9   | Cross-platform paths        | Use `path.join` everywhere. Test on Windows in CI.                                             | DorkOS already runs cross-platform. Don't regress.                                |
| 10  | Reinstall behavior          | `dorkos install <name>` is idempotent. No-op if same version. Force with `--force`.            | Predictable. Safe re-runs.                                                        |

---

## Acceptance Criteria

- [ ] `dorkos install <name>` installs from configured marketplaces
- [ ] `dorkos install <name>@<marketplace>` installs from a specific marketplace
- [ ] `dorkos install github:user/repo` installs from any git URL
- [ ] All four package types install correctly with full validation
- [ ] Failed installs roll back atomically — no partial state on disk
- [ ] Permission preview shows accurate summary before install
- [ ] `dorkos uninstall <name>` cleanly removes a package
- [ ] `dorkos update <name>` notifies of newer versions (does not auto-install)
- [ ] `dorkos marketplace add <url>` adds a marketplace source
- [ ] `dorkos marketplace list` lists configured marketplaces
- [ ] HTTP install API endpoints work end-to-end (used by spec 03 UI)
- [ ] Cache hit rate > 80% for repeated operations within TTL
- [ ] Conflict warnings appear when expected
- [ ] All install flows tested via Vitest + integration tests
- [ ] Zero changes to existing template-downloader.ts (extended, not replaced)
