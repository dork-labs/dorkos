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

The tasks tools then move into `services/tasks/agent-tools/`, already on both
of Security's lists (`services/tasks/`), and reach the helpers they used in
other domains through `AgentToolDeps.tasksReach`, wired by
`startup/task-tool-reach.ts`: that file joins the main list (with a parity row
and a look-alike), since what it wires is their audit rows, marks and notices.
`core/turn-power/marked-turn-copy.ts` becomes a third port: the tool
descriptions read it when they load, so it cannot be handed in, and it imports
no domain. The old `runtimes/claude-code/mcp-tools/tasks/` entries on both lists
now match nothing; they are left for Security to prune.
