---
covers:
  - 'feat(harness): a sixth home-directory carve-out, for the folder five tools read (DOR-1924)'
  - 'feat(config): global scope remembers which tools it shares with (DOR-1924)'
  - "feat(harness): a global package's skills reach the folders your tools read (DOR-1924)"
  - 'feat(cli): DorkOS asks once before it puts a link in your home folder (DOR-1924)'
  - 'test(harness): the J-07 journey, and the case that guards what a session keeps (DOR-1924)'
  - 'test(server): the new config writer says which gate stands in front of it (DOR-1924)'
  # Folds in here: all three refine this same unreleased behaviour, and nothing a
  # person could have seen before it.
  - 'fix(harness,cli): the lines about a shared package stop saying nobody can see it (DOR-1924)'
  - 'fix(config): the migration key moves to 0.77.0, because 0.76.0 landed first (DOR-1924)'
  - 'refactor(server,cli): the configured boundary root is read in one place (DOR-1924)'
  - 'fix(cli): a confined deployment says what it cannot reach, not that it found nothing (DOR-1924)'
  - 'fix(harness,cli): a run that shares with Claude Code alone says so (DOR-1924)'
---

### Added

- A package you installed for all your projects can now be shared with your other agent tools. Run `dorkos harness sync --global` and DorkOS asks once: it shows the two folders in your home directory it would use, names every link it would add, and writes nothing until you answer. Say yes with `dorkos harness global --enable <tool>`, once per tool you want (DOR-1924)
- `dorkos harness global --list` shows what you chose and where the links go. `--disable <tool>` stops sharing with one tool and removes the links that tool's folder no longer needs first. Five tools share one folder, so turning one off while another still reads it removes nothing (DOR-1924)
- DorkOS only ever creates links in those two folders, never files, and it only ever removes a link it made itself. Your own skills, and shortcuts you made yourself with the same shape, are left exactly where they are. If you uninstall a package later, DorkOS removes its links too (DOR-1924)
- The line about a package you installed for all your projects now says it is shared once you have shared it, and tells you which command shares it until then (DOR-1924)

### Changed

- If you told DorkOS to stay inside one folder on this machine, it does not put links in your home directory. It says so, names the folder you set, and your timed skills keep running (DOR-1924)
- Saying no is remembered. DorkOS asks the question once, and a no means it does not ask again (DOR-1924)
- If one of those folders is a file, or DorkOS may not write in it, the run says which folder and what to do about it. It used to stop with an error nobody can read, after it had already recorded your answer (DOR-1924)
