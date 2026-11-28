---
id: 261127-232656
title: Security's path lists cover the agent tool kit and tool names' kernel homes (C9a)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C9a (DOR-5482) moves `AgentToolDeps` and the tool result helpers out of
Claude Code's `mcp-tools/types.ts` into `services/core/agent-tool-kit/`, and the
tool name constants out of `runtimes/shared/dorkos-tool-names.ts` and
`mcp-tools/tool-exposure.ts` into `services/core/tool-names/`, so a tool file in
a turn-port domain never imports `runtimes/**`. The tasks tools read the kit and
sit on Security's main list, and the names decide which calls Claude Code's
own layer auto-allows, so both homes join the main list in `security-gate.yml`'s
`SECURITY_PATH_PATTERN`, its regex fixture and `Policy.swift`, each with a
parity row and a look-alike path that stays off. Not the deep list: neither
holds a gate, a tier or an escalator.

The same change names both files as ports of the services import boundary
(`eslint-rules/import-boundary.js`): every domain imports them, and they import
no domain except for types. Hypothesis: no pair is added and the counts only
fall. Revert only with the move itself.
