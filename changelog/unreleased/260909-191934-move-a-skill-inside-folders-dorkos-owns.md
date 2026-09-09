---
covers:
  - 'feat(shared,server): harness.autoAdopt, off everywhere by default (DOR-1945)'
  - 'feat(server): the boot pass reports skills only one tool can see (DOR-1945)'
  - 'feat(cli): sync says when harness.autoAdopt does nothing here (DOR-1945)'
  # Folds in here: it corrects the pluralisation of a sentence the second bullet
  # writes, before anybody could have seen one, so there is nothing to report as
  # a fix of its own.
  - 'fix(server): the boot hint counts in singulars when there is one (DOR-1945)'
---

### Added

- DorkOS can now move a plainly-portable skill into the shared folder every agent reads, on its own — but only inside the agent folders and room folders DorkOS made, only when you turn it on with `dorkos config set harness.autoAdopt true`, and only for a skill whose settings hold nothing one tool alone understands. Everything else is reported, with the one sentence saying why, and left exactly where it is (DOR-1945)
- Every server start now says which skills in your agents' folders only one of your coding tools can see, names each one with the command that moves it, and gives that command your agent folder's full path so it means the same thing wherever you paste it. It says this whether or not you turned the setting on, because knowing is the point (DOR-1945)
- If you turn the setting on and then run `dorkos harness sync` in one of your own projects, it tells you in one line that the setting does nothing there and that `dorkos harness adopt <name>` is how you move a skill yourself. Nothing in your own repositories is ever moved for you (DOR-1945)
