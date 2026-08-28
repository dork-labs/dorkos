---
covers:
  - 'feat(shared,skills,db): a scheduled task can name its runtime, model and effort (DOR-1615, DOR-1347)'
  - 'feat(server): a scheduled run resolves and records what it actually runs on (DOR-1615, DOR-1347)'
  - 'feat(relay): a run sent over the message bus starts on the model it was sent with (DOR-1615, DOR-1347)'
  - 'feat(server,cli): the task doors take runtime, model and effort (DOR-1615, DOR-1347)'
---

### Added

- A scheduled task can now say which agent runtime it runs on — Claude Code,
  Codex or OpenCode — which model, and how hard that model thinks. Set them in
  the task's file, over the API, from the `dorkos task create` command, or by
  asking an agent to set them for you (DOR-1615, DOR-1347)
- Leave all three unset and nothing changes: the task runs on whatever its agent
  runs on, which is what every scheduled task did before. Setting one is an
  override, and clearing it goes back to following the agent (DOR-1615)
- Run history now records what each run actually ran on, not what the task says
  today. Move a task to a different runtime next week and its old runs still
  report the truth about themselves (DOR-1615, DOR-1347)

### Changed

- Scheduled runs used to happen on Claude Code no matter what the task or its
  agent said, on whatever model came out of the box. They now walk the same
  ladder every other kind of turn walks: the task's own setting, then the skill
  file's, then the agent's, then your default for that runtime (DOR-1615,
  DOR-1347)
- A task set to a runtime you have not turned on now fails its run and says so,
  naming the runtime and what to do about it. It never quietly runs somewhere
  else — a run on a different runtime is a different run, billed to a different
  account, and you would have had nothing on screen to tell you (DOR-1615)
- A task that remembers its last run, and that you then move to a different
  runtime, starts a fresh conversation instead of trying to pick up one that
  lives in another program's history. Its earlier runs are all still there to
  read (DOR-1615)
