---
id: 261126-013138
title: The services import rule names one port and one composition root (DOR-4924 follow-up)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The import rule (ledger `261125-233242`) counted two kinds of import that are a decision, not a tangle. ADR `261123-170830` makes the capability registry the one place a capability is defined, so every domain must import `defineCapability`, and `core/self-description/dorkos-registry.ts` must import every domain. Counted, each moved route (DOR-4978) raised a pair, and the API lead's PRs could not land.

The rule now names two exceptions, each one file with a reason and the record behind it (`PORTS` and `COMPOSITION_ROOTS` in `apps/server/eslint-rules/import-boundary.js`): an import into `core/capabilities/capability-definition.ts` makes no edge, and neither do the registry file's own imports. The port must stay a leaf: a value import from it into another domain is refused by the rule and failed by the checker. A domain importing the registry still counts, and so does anything else in `core/capabilities/`. Adding an entry is an edit to the rule file with a ledger entry, read by the architect. The computer wall is unchanged.

The 47 files that took `defineCapability` from `core/capabilities/index.js` now take the port's names from the port; 4 computer-side files keep one import, because splitting it would have raised their computer-wall count. The baseline falls from 578 pairs (113 both ways) and 2,143 import statements to 554 pairs (112 both ways) and 2,041 statements, measured on main `56d6ba4bae`.

Revert if the lists grow without decided records behind them, or if the port stops being a leaf.
