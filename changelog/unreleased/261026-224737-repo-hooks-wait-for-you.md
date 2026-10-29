---
covers:
  - "fix(server): an agent can't approve its own hooks or MCP servers in a repo or worktree (DOR-3298)"
  - "fix(server): close the review's holes in the repo settings check (DOR-3298)"
  - 'fix(server): a trust card shows the commit a yes records, not the worktree (DOR-3298)'
  - "refactor(server): route the repo settings git reads through the safe runner's API (DOR-3298)"
  - "fix(server): a repo DorkOS hasn't pinned, or whose default branch changed its hooks, waits for a person (DOR-3298)"
  - "fix(server): close Security's five Musts on the repo settings check (DOR-3298)"
  - 'fix(server): a repo commit in between that touched .claude asks a person, and repo git reads skip your git config (DOR-3298)'
  - 'fix(server): a skill linked in from .agents no longer asks on every turn, and the repo card says what changed (DOR-3298)'
  - 'fix(server): a commit in between that changed a linked skill anywhere in the repo asks a person (DOR-3298)'
  - 'fix(server): agents can no longer change their own skills or commands (DOR-3068)'
  - 'fix(server): a new agent whose folder runs anything waits for a person (DOR-3068)'
  - 'fix(server): held agent folder settings stop every setting that runs code, and the runtime (DOR-3068)'
  - "fix(server): close the pin's gaps: a renamed agent, plugin scripts, more settings that run code (DOR-3068)"
  - "fix(server): an agent can't change its own hooks, MCP servers or account without a person (DOR-3068)"
  - "fix(server): an agent's file tools can't rewrite an installed plugin (DOR-3068)"
  - 'fix(docs): close the folderConfigPinned row a merge split, and fold the seeded DOR-3298 fragments into one (DOR-3298)'
---

### Fixed

- In Claude Code chats, an agent working in a project or worktree can no longer give itself more power by editing the project's settings. If it adds hooks or allowed commands to the local settings file that isn't checked in, that file doesn't load until you approve it. If it changes the project's checked-in hooks, the scripts they run, or the hooks a subagent or skill sets, none of the project's own settings load in that worktree until you approve the change: its hooks, and its settings that run commands. Your own settings and hooks still run. If it adds a command the checked-in settings allow without asking, DorkOS still asks before running it. If it changes `.mcp.json`, only the MCP servers from the default branch start. Each time, an approval card shows you the change and Activity names the files. Approve a change once and it runs in every worktree that has it. A project DorkOS hasn't seen before waits for your yes once, and so does a default branch that changes its hooks; projects you already had are trusted as they were. Undo the edit and things go back to normal on their own.
