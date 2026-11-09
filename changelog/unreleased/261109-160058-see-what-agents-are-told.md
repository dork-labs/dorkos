---
covers:
  - 'feat: see what agents are told, from the builders that write it (context viewer phase 3)'
  - 'fix(server): agent_instructions joins the guarded read-only tools on the external MCP server'
---

### Added

- **See what every agent is told.** Settings › Agent instructions lists each part of the instructions DorkOS gives agents, in the order the model reads it. Each part says where it comes from, when it is included, roughly how long it is, and whether it is locked. Spots that differ per agent, like its name, show as small chips.
- **Switch runtime, place and level.** Pick Claude Code, Codex, OpenCode or Doe, and a direct chat, a room or a scheduled task. Notes say what each runtime adds that DorkOS can't show, like Claude Code's own built-in instructions.
- **Preview as an agent.** "Preview as…" fills the chips in for one agent.
- **Each agent's profile has What this agent is told.** It shows that agent's own result, for its own runtime and level. The Instructions, Boundaries and Memory pages link to it.
- **Agents can read the template too.** A new tool shows an agent the same list, with chips and no one's details, or only the parts its own next turn gets.

### Changed

- **The small preview under the Instructions and Boundaries editors is gone.** It rebuilt part of the instructions in the app and could fall out of step. The new page is written by the same code a real chat uses.
