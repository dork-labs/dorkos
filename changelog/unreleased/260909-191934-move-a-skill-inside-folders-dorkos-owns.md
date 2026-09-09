---
covers:
  - 'feat(shared,server): harness.autoAdopt, off everywhere by default (DOR-1945)'
  - 'feat(server): the boot pass reports skills only one tool can see (DOR-1945)'
  - 'feat(cli): sync says when harness.autoAdopt does nothing here (DOR-1945)'
  # Folds in here: it corrects the pluralisation of a sentence the second bullet
  # writes, before anybody could have seen one, so there is nothing to report as
  # a fix of its own.
  - 'fix(server): the boot hint counts in singulars when there is one (DOR-1945)'
  - 'feat(cli): adopt knows a room worktree when you are standing in one (DOR-1945)'
  # Folds in here too: it corrects which skills the second bullet's line counts
  # and names, before anybody could have read one.
  - 'fix(server): the boot report counts what it can still say something about (DOR-1945)'
  # And the correction to that correction, which is what makes the first two
  # bullets true in a real agent folder — all before anybody could have run one.
  - 'fix(server,shared): the owned-workspace report asks what DorkOS can run (DOR-1945)'
  # Same fold: the route takes this slice's resolver at landing (slice 4 shipped with the literal).
  - "feat(server): the adopt route resolves the folder's ownership from its shape (DOR-1945)"
---

### Added

- DorkOS can now move a plainly-portable skill into the shared folder every agent reads, on its own — but only inside the agent folders and room folders DorkOS made, only when you turn it on with `dorkos config set harness.autoAdopt true`, and only for a skill whose settings hold nothing one tool alone understands. Everything else is reported, with the one sentence saying why, and left exactly where it is (DOR-1945)
- Every server start writes a line into the DorkOS log for each agent folder holding a skill only some of your coding tools can see. It names the skills, says which tools cannot see them, and gives you the command that moves each one — with your agent folder's full path in it, so it means the same thing wherever you paste it. You get that line whether or not you turned the setting on, because knowing is the point (DOR-1945)
- `dorkos harness adopt` now knows when you are standing in a room's own folder, and refuses to move a skill whose name matches one DorkOS puts in every room folder — that folder gets cleaned up, and the skill would go with it. It tells you to rename yours and adopt it under the new name. The same skill in one of your own projects still moves (DOR-1945)
- If you turn the setting on and then run `dorkos harness sync` in one of your own projects, it tells you in one line that the setting does nothing there and that `dorkos harness adopt <name>` is how you move a skill yourself. Nothing in your own repositories is ever moved for you (DOR-1945)
