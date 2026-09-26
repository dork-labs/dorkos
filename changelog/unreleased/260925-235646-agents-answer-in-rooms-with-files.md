---
covers:
  - 'fix(rooms): let agents act as themselves in a room with files (DOR-2091)'
  - 'fix(rooms): close the identity gaps review found in the worktree anchor (DOR-2091)'
  - "fix(rooms): take a room session's agent from its binding, not the message (DOR-2091)"
  - 'fix(rooms): refuse a room worktree whose owner is no longer a registered agent (DOR-2091)'
---

### Fixed

- Agents answer again in a room that has its own files. When login was on, an agent working in its copy of the room's files couldn't post, react, read the history or send you a note, so the room showed that it "read this and did not reply." This hit Claude Code, Codex and OpenCode agents alike. With login off, some of those posts carried your name instead of the agent's. Now each agent's posts carry its own name, and a working copy DorkOS can't tie to the agent it's working for can't post as anyone (DOR-2091)
