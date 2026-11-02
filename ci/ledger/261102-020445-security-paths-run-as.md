---
id: 261102-020445
title: Security gate covers the code that decides who a turn or a schedule runs as, and the P0 identity paths need a deep review
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-3640 showed that whoever picks a session's folder or a schedule's target picks who it runs as. The code that decides that (the session launch service, the scheduled-task service, agent identity, the external MCP tools, and the `session_start` and `tasks_*` tools) sat outside `SECURITY_PATH_PATTERN`. So #3417 and #3418 could have merged without Security's label.

`security-gate` now treats those folders as security paths, and the pattern's reviewed copies (`fixtures/security-path-pattern.regex`, `tools/security-approve/Policy.swift`) move with it. No required check, shard, retry or timeout changes. More PRs will wait for Security's label; that is the point.

The P0 identity paths inside that list (`SECURITY_DEEP_PATH_PATTERN`: the scheduled-task service, session launch, agent identity, the external MCP tools, the `session_start` and `tasks_*` tools, the room repo's git, and, added at 13:14 the same day, `core/turn-power`, `core/permissions`, `core/auth`, `lib/git-safety.ts`, `shared/src/safe-git.ts`, `core/runtime-registry.ts` and `workspace/room-session-place.ts`) also need a second label, `security-deep-reviewed`, from a person, newer than the last push, in label-at-head mode (agreed in #dorkos, 2026-11-02 02:04 and 02:05; widened 13:14). `core/permissions/` joins `SECURITY_PATH_PATTERN` too, since a deep path must be a security path. Security's 07:13 Musts also widen `SECURITY_PATH_PATTERN` to the database schema and migrations (`packages/db`), both git runners, the message dispatcher, the runtime registry, `services/workspace`, `binding-tools.ts`, `services/audit`, `services/heartbeats` and `services/session/fleet`. A push voids it the same way it voids `security-reviewed`. Every other security path keeps the one label. App mode is unchanged: the App's status is the approval there.

Revert, or narrow a path, if Security rules a path does not decide identity or power. Drop the second label if Security finds it adds a step without catching anything the first label misses.
