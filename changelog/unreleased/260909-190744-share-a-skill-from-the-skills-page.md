---
covers:
  - 'feat(server,shared): move one skill from the app with POST /api/harness/adopt (DOR-1946)'
  - 'feat(client): share a skill with every agent from the Skills page (DOR-1946)'
  # Folds in here: it tightens the refusal's machine-readable half and makes the
  # row announce its outcome, before either bullet below has shipped, so there is
  # nothing to report as a fix.
  - 'fix(server,client): the adopt refusal is a closed rule, and the row says so out loud (DOR-1946)'
---

### Added

- The Skills page can now move a skill for you. A skill sitting in one tool's own folder — where the rest of your agents cannot see it — gets a **Share with every agent** button. Pressing it asks first, naming the folder it moves from, the folder it moves to, and the link it leaves behind so Claude Code still finds it. Say yes and the row redraws on the spot: the tools that could not see the skill now say they read it. The command that does the same thing from a terminal is still printed right beside the button (DOR-1946)
- If DorkOS will not move a skill — its settings are Claude Code's own, something already sits in the way, the folder is really a link somewhere else — the row says so in one plain sentence, in the place the advice was, and nothing on disk is touched. Screen readers are told the sentence as it arrives (DOR-1946)
