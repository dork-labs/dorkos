---
covers:
  - "fix(server): an agent can't approve its own hooks or MCP servers in a repo or worktree (DOR-3298)"
---

### Fixed

- An agent working in a project or worktree can no longer give itself more power by editing the project's settings. If it adds hooks or allowed commands to the local settings file that isn't checked in, that file doesn't load until you approve it. If it changes the project's checked-in hooks, the scripts they run, or the hooks a subagent or skill sets, none of the project's hooks run in that worktree until you approve the change. If it adds a command the checked-in settings allow without asking, DorkOS still asks before running it. If it changes `.mcp.json`, only the MCP servers from the default branch start. Each time, an approval card shows you the change and Activity names the files. Approve a change once and it runs in every worktree that has it. A project DorkOS hasn't seen before waits for your yes once, and so does a default branch that changes its hooks; projects you already had are trusted as they were. Undo the edit and things go back to normal on their own.
