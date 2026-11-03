---
covers:
  - "feat(tasks): agents set their own schedules' modes up to their own level, and a changed SKILL file runs capped at Never ask (DOR-3703)"
---

### Added

- An agent can set how its own scheduled task runs, from its own chat, up to its own level. An agent that runs at Bypass permissions can set Bypass; one that runs at Default cannot go past Default, and asking for more is refused. A task runs at a mode looser than Never ask when you approved it as it is, or when its own agent set it from its own chat; a change from a scheduled run, or from another agent, waits for you first. Another agent's task, a chat working from a linked git worktree, or one that read messages from outside your team asks you instead, and after outside messages it can set Never ask at most. Approving a waiting task asks you unless you allow **Approve a scheduled task**, and an agent never approves a task it made or changed. When an agent raises its own task's mode, or rewrites its prompt, the task keeps running and you get a notice saying what changed and who started it, with **Undo** to put it back; only you can use it. The task shows which agent changed it and when, and so does Activity. If a task's SKILL file is changed outside DorkOS, the task keeps running but at Never ask, so some steps may fail; its run history and its row say so and name the steps it couldn't take. You get one notice, and its own agent can accept the file from a chat, or you can press **Approve file** on the task, read what changed, and approve it. To turn this off, set `tasks.agentModeControl` to false.
