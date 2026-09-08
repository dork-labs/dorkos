---
covers:
  - 'feat(harness): one consent seam, and refusals that outlive the process (DOR-1849)'
  - 'feat(cli): harness sync withholds unapproved hooks and says so (DOR-1849)'
  - 'fix(harness,cli): a refusal wins, an unreadable config says so (DOR-1849)'
---

### Changed

- Some packages ship hooks: commands your coding agent runs on its own. `dorkos harness sync --fix` used to install every one of them, even from a package you had turned down. Now it holds those back, sets up everything else, and prints each command it did not install, so you can see what it skipped and why (DOR-1849).
- Say `dorkos harness sync --fix --allow-hooks <package>` to install that package's hooks. DorkOS remembers your answer, so you only say it once. `dorkos harness hooks --list` shows every package you have decided about, and `dorkos harness hooks --revoke <package>` forgets one so you get asked again (DOR-1849).
- When you turn a package down, DorkOS now remembers that too. It used to forget on the next restart (DOR-1849).
- If DorkOS cannot read your settings file, it says what is wrong with it and holds every package's hooks back, instead of telling you that nothing has been decided. It will not write over a file it cannot read (DOR-1849).
