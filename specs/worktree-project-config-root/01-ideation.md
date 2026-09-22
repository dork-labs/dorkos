---
slug: worktree-project-config-root
id: 260922-223212
created: 2026-09-22
status: ideation
---

# Take project settings from the trusted checkout for worktree agents

**Author:** Claude Code (from the 0.3.268 → 0.3.280 SDK upgrade triage)
**Research:** [`research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md`](../../research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md) (MEDIUM: `Options.projectConfigRoot`)
**Blocked by:** the claude-agent-sdk 0.3.280 bump; related: workspaces direction (DOR-1056)

## Problem

DorkOS runs agents in git worktrees routinely (workspaces, `/flow` EXECUTE). For such a session, project settings, hooks, permission rules, `.mcp.json`, the `.claude` trees and `CLAUDE_PROJECT_DIR` come from whatever the branch carries. A branch that adds a hook or a permissive rule takes effect for the agent running on it.

## Suggested approach

- When a session's `cwd` is a worktree DorkOS created, pass `Options.projectConfigRoot` pointing at the trusted main checkout.
- Verify CLI-side support first: the option exists in the 0.3.280 types but has no release note, so its behavior is unverified. One live check: a hook added only on the branch must not fire.
- Decide how a person opts a worktree back into its own branch settings when they want that.

## Open questions

- Which checkout is "trusted" for a clone-provider workspace (no shared main checkout)?
