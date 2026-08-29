---
covers:
  - 'feat(shared,skills,db): a scheduled task can name its runtime, model and effort (DOR-1615, DOR-1347)'
  - 'feat(server): a scheduled run resolves and records what it actually runs on (DOR-1615, DOR-1347)'
  - 'feat(relay): a run sent over the message bus starts on the model it was sent with (DOR-1615, DOR-1347)'
  - 'feat(server,cli): the task doors take runtime, model and effort (DOR-1615, DOR-1347)'
  - "fix(server): the execution ladder reads the agent's own directory, not the run's cwd (DOR-1615)"
  - 'fix(server): a task naming a prototype key for its runtime no longer 500s the create (DOR-1615)'
  - 'fix(server): the sticky runtime-change rule reads the run row, so it actually fires (DOR-1615)'
  - "fix(server): a new task's trust stop is read in its AGENT's runtime vocabulary (DOR-1615)"
  - 'test(server): the two task power route tests answer the registry question the create path now asks (DOR-1615)'
  - 'docs(shared,db,changelog): say where resolved_model and the skill effort tier stop short (DOR-1615, DOR-1347)'
  - 'docs(api): regenerate the OpenAPI spec and reference pages (DOR-1615, DOR-1347)'
  - 'feat(client): a scheduled task picks its runtime, model and effort in the app (DOR-1615, DOR-1347)'
  - 'feat(operating-skills): agents learn that a task can name its runtime, model and effort (DOR-1615, DOR-1347)'
  - "fix(client): a task's stored effort stays readable when its model's ladder is shorter (DOR-1347)"
  - 'fix(client): a task moved to another runtime asks before it stops asking (DOR-1615)'
---

### Added

- A scheduled task can now say which agent runtime it runs on — Claude Code,
  Codex or OpenCode — which model, and how hard that model thinks. Pick them
  under **Advanced settings** when you create or edit a task, or set them in the
  task's file, over the API, from the `dorkos task create` command, or by asking
  an agent to make you a task with them (DOR-1615, DOR-1347)
- The task form tells you when a choice no longer works: a runtime you have not
  turned on, or a model that runtime does not offer — which is what you see if
  you pick a model for one runtime and then move the task to another. It never
  drops the choice for you (DOR-1615, DOR-1347)
- A task that runs somewhere other than its agent says so on its row, and
  nowhere else — the tasks that simply follow their agent stay quiet (DOR-1615,
  DOR-1347)
- Leave all three unset and nothing changes: the task runs on whatever its agent
  runs on, which is what every scheduled task did before. Setting one is an
  override, and clearing it goes back to following the agent (DOR-1615)
- Run history now records what each run ran on, not what the task says today.
  Move a task to a different runtime next week and its old runs still report the
  truth about themselves (DOR-1615, DOR-1347)

### Changed

- The permissions dial on a task now describes what will actually happen on the
  program the task runs on, instead of always describing Claude Code. And if you
  move a task to a program where its setting means "never stop to ask", the app
  asks you first rather than making the change quietly (DOR-1615)
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
- One rough edge worth knowing: if a task remembers its last run and you change
  its model, the next run may carry on with the old model until that
  conversation is put down. Tasks that start fresh each time — the default —
  always use the model you picked (DOR-1347)
