---
id: 260923-163034
title: An update is checked and applied per installation, in the installation's own scope
status: draft
created: 2026-09-23
spec: marketplace-update-all
superseded-by: null
---

# 260923-163034. An update is checked and applied per installation, in the installation's own scope

## Status

Draft (extracted from spec: marketplace-update-all)

## Context

One package can be installed several times: globally, in a project, and in several agents' projects. The installed list has returned one entry per installation since DOR-994, keyed in the app by `installPath`. The update check did not. It walked the global scope plus at most one project, and it reported by package name.

The apply was worse. It reinstalled into whatever `projectPath` the request carried. So `dorkos update <name> --apply --project <dir>` on a globally installed package deleted the global install and reinstalled it into the project, and a name-less `--apply --project` did that to every global package.

## Decision

The unit of an update is an installation, not a package name.

- A check is reported per installation. It carries that installation's identity: `installPath` (the key), `type`, `scope`, and `agentPath`/`agentId`/`agentName` for a non-global one. The same name in two scopes is two results.
- An apply reinstalls each installation in the scope it was found in. A global installation is reinstalled with no `projectPath`, whatever scope the request named. This holds for the per-package door and the all-packages door alike.
- The all-packages door checks the installations from one scan (`scanInstallationRecords`), a few at a time. It applies them one at a time and records a failed reinstall on that installation instead of abandoning the rest.
- A batch apply is authorized per reinstall, as `marketplace.install`, before any network work. A batch that would need a person's approval is refused rather than half-run, because a batch cannot carry one approval token per package.

## Consequences

### Positive

- The installed list, the update check and the Installed view all describe the same set, joined on one key.
- An update never moves a package between scopes.
- One broken installation cannot hide what a batch already reinstalled, or skip its refresh.

### Negative

- A batch apply cannot wait for approval. If `marketplace.install` is ever raised to a tier that asks, batches are refused, and a batch-approval design is needed.
- A result per installation is longer than a result per name when one package is installed in many places. Consumers group by name if they want to.
