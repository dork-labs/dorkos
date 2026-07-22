# Ideation: Agents as First-Class Operators of DorkOS

- **Slug:** agents-as-operators
- **Date:** 2026-07-22
- **Tracker:** DOR-428 (project: Agents as First-Class Operators)

## Intent

DorkOS agents must be the best users of DorkOS: aware of everything about it, able to do anything a user can do (create agents, manage groups, read activity, schedule tasks, configure runtimes, operate the marketplace, change their own personality), and able to act on the user's behalf so the user never has to touch the cockpit if they don't want to. DorkBot is the flagship beneficiary: the shipped "DorkBot is the onboarding" work gave DorkBot a voice; this program gives every agent (DorkBot first among them) hands.

## Ideation artifact

The full ideation lives in **`research/20260722_agents-as-first-class-operators.md`** (2026-07-22): a verified current-state audit of all four actuation projections (in-session MCP, external MCP, CLI, OpenAPI) and the knowledge layer, an external-patterns survey (Home Assistant LLM API, CLI-vs-MCP evals, SKILL.md progressive disclosure, Voyager skill libraries, agent governance consensus), the target architecture (Capability Registry, CLI-first actuation, skills-first knowledge, tiered permissions), a 14-item gap inventory, and a 4-phase sequencing plan. This file is a pointer, not a duplicate; the research report is the ideation of record.

## Decisions carried into SPECIFY

Resolved during ideation (rationale in the research report and in `02-specification.md`):

1. One Capability Registry as the eventual single source of truth, adopted incrementally (phase 2), never a big-bang rewrite.
2. CLI-first actuation because the CLI is the only surface reachable from all three runtimes (Codex and OpenCode cannot receive MCP injection) and is empirically cheaper and more reliable for agents than large tool schemas.
3. Knowledge ships as a first-party "Operating DorkOS" skill pack plus runtime self-description, not context stuffing.
4. Governance arrives as observe/act/destructive tiers with audit through ActivityService (phase 3); phase 1 stays within today's trust model.
5. Testing splits into deterministic Vitest conformance (per-PR) and outcome-oracle evals in `packages/evals` on the `claude-code-cheap` tier, in sandboxed `DORK_HOME`s, with the Docker isolation tier built for destructive scenarios.

## Directive

Directed by Dorian (2026-07-22): execute via /flow, orchestrator + named subagents (Opus/Sonnet only), all code in worktrees, separate reviewer agent per REVIEW.md, gates bypassed where a solid decision or reasonable assumption is possible.
