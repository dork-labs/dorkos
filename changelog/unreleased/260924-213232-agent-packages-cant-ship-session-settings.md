---
covers:
  - 'fix(marketplace): an agent package can no longer ship settings for its own sessions, and its skills are on the install screen (DOR-2314)'
---

### Security

- An agent package installs into the folder its sessions run in, so settings it shipped there could run commands, start servers or let the agent act without asking, and none of it was on the install screen. DorkOS now refuses an agent package that ships them: Claude Code's `.claude/settings.json`, a `.mcp.json`, a subagent with its own hooks or servers, Codex's `.codex/` folder, and OpenCode's `opencode.json` or `.opencode/` folder. Instructions and skills are still fine, and the install screen now lists what the skills in those folders may do without asking (DOR-2314)
- When DorkOS won't install a package, the install screen and the package page now say so and why, instead of showing "No special permissions required" (DOR-2314)
- A package can no longer mark those settings folders as yours to edit, so an update always runs exactly what you approved (DOR-2314)
