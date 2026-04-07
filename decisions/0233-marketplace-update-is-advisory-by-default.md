---
number: 233
title: Marketplace Update Is Advisory by Default — Never Auto-Apply
status: draft
created: 2026-04-06
spec: marketplace-02-install
extractedFrom: marketplace-02-install
superseded-by: null
---

# 233. Marketplace Update Is Advisory by Default — Never Auto-Apply

## Status

Draft (auto-extracted from spec: marketplace-02-install)

## Context

Most package managers (npm, pip, brew, apt) ship some flavour of automatic update behaviour: a daemon, a notification, a `--auto-update` flag, or an opt-in subscription that pulls in new versions without explicit user action. The convenience is real — but the cost is that users wake up to a working system with mutated dependencies they did not approve.

DorkOS marketplace packages are not background dependencies. They are agents the user sees in their fleet, plugins that change how their editor behaves, skill packs that alter how their agents reason, and adapters that talk to their personal Slack / Telegram / GitHub. A silent update to any of these is more like a personality change than a security patch. The Kai persona — primary user, runs 10–20 agent sessions a week — explicitly does not want his tools mutating without his consent.

The question for `dorkos update` was: what does the bare command do?

## Decision

`dorkos update` is **advisory by default**. It enumerates installed packages, compares their installed version against the latest available version in the marketplace catalog, and prints (or returns, via the HTTP API) the comparison. **It never touches disk.**

To actually apply an update, the user must pass `--apply` (CLI) or set `apply: true` in the HTTP request. Even then, every update goes through the same `MarketplaceInstaller.install` pipeline as a first-time install — it shows the same permission preview, runs the same conflict detection, and runs inside the same atomic transaction. There is no fast path. There is no batch "update everything" without an explicit confirmation per package.

The reinstall pattern is uninstall-without-purge → install. This preserves `.dork/data/` and `.dork/secrets.json` across versions so the user does not have to re-enter API keys or lose persistent state.

Implementation: `apps/server/src/services/marketplace/flows/update.ts`. The flow forward-declares an `InstallerLike` interface to break the circular dependency on the orchestrator.

## Consequences

### Positive

- Honest by design: a marketplace package never changes without the user typing `--apply`. Aligns with the brand voice ("control panel, not consumer app") and the project's "Honest by design" decision filter.
- Update checks are zero-cost — they touch no files, mutate no state, and can run as often as the user likes (or in a future periodic background poll) without consequence.
- The same install pipeline handles updates, so there is exactly one place that knows how to put marketplace packages on disk. Bug fixes to install propagate to update for free.
- The advisory result is structured (`{ packageName, installedVersion, latestVersion, hasUpdate, marketplace }[]`) so future UI surfaces (dashboard "updates available" badge, dorkbot notifications) can consume the same data.
- Secrets and per-package data survive updates because reinstall composes uninstall-without-purge with install — no special "in-place upgrade" code path to maintain.

### Negative

- Users coming from npm / brew may expect `dorkos update foo` to "just do it" and be momentarily surprised when they get a report instead of an upgrade. The CLI help text and the printed advisory output need to make the `--apply` requirement obvious.
- Updates require two commands in the common case (`dorkos update` to learn what is available, then `dorkos update foo --apply` to do it). A future quality-of-life pass could add an interactive confirm-and-apply mode without changing the default.
- We do not get the security benefit of auto-pushed patch updates. If a package author publishes a fix, every user has to opt in. This is the right trade for an agent marketplace (the failure mode of a silent agent update is worse than a delayed patch) but it would be the wrong trade for, say, a runtime dependency.

## Alternatives Considered

- **Auto-update by default, with `--no-update` to opt out** — Rejected. Violates the Apple Test (the user did not ask for this) and the Honest-by-design filter. The first time a user's agent behaves differently after a silent update, they lose trust in DorkOS.
- **Auto-update only patch versions (`x.y.Z`)** — Rejected. Semver discipline is uneven across the marketplace ecosystem we expect (community packages, hand-rolled tooling). A "patch" version bump can change behaviour. We do not want the rule "we silently mutate your tools sometimes, depending on a number".
- **Background daemon that prompts on update** — Rejected. Adds a long-running process that has to know about every installed package, and turns notification policy into a UX problem. The advisory-on-demand model gets the same information across without owning notification surface area.
