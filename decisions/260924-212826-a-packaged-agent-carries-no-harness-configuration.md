---
id: 260924-212826
title: A packaged agent carries no harness configuration for its own sessions
status: draft
created: 2026-09-24
spec: agent-workspace-config
superseded-by: null
---

# 260924-212826. A packaged agent carries no harness configuration for its own sessions

## Status

Draft (auto-extracted from spec: agent-workspace-config)

## Context

An agent package's folder becomes the agent's working directory. Claude Code, Codex and OpenCode each load configuration from there:

- Claude Code: `.claude/settings*.json`, a root `.mcp.json` and project subagents.
- Codex: `.codex/`.
- OpenCode: `opencode.json(c)` and `.opencode/`.

Harness Sync projects `.claude/settings.json` hooks into the hook files of the harnesses its manifest names. That configuration runs hooks, starts servers and approves tools before DorkOS is asked. The install preview showed none of it, and `userEditable` could keep a person's edited copy across an update.

## Decision

A packaged agent carries what the agent is (instructions, persona, skills), never the configuration of the harness its sessions run under.

The validator refuses an agent package that ships any of these, matched case-insensitively:

- `.claude/settings.json` or `.claude/settings.local.json`;
- a root `.mcp.json`;
- `.codex/`;
- `opencode.json`, `opencode.jsonc` or `.opencode/`;
- `.agents/harness.manifest.json`;
- `.gemini/settings.json`;
- a `.claude` folder anywhere below the root;
- a subagent that sets `hooks`, `mcpServers` or `permissionMode`, or that DorkOS can't read the way Claude Code does (not YAML, a repeated key, deeper than it walks).

The skills an agent's sessions load from its folder (`.claude/skills`, `.claude/commands`, `.agents/skills`) are read by the install preview. The approved disclosure binds them. None of these paths can be `userEditable`, in any package.

This extends ADR 260803-233420's third guarantee from `.dork/agent.json` to every harness file in the folder. It chooses refusal over disclosure: these files mix many code-running and trust-widening keys, harnesses keep adding more, and an approved allow rule keeps approving with no gate in front of it.

## Consequences

### Positive

- One rule covers every harness DorkOS runs. It fails closed when a harness adds a key.
- Hooks, servers and permissions for a packaged agent arrive only through DorkOS's gated paths.

### Negative

- A package author who wants an agent with hooks has to ship them in a plugin the agent `requires`. Those hooks then go through hook consent.
- The app creates a marketplace agent by cloning its source as a template, and no validation runs there. The app blocks creation when the server refuses the package's preview, but the clone is not bound to it; DOR-2325 closes that.
