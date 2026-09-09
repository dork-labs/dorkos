---
covers:
  - 'feat(harness): a sixth home-directory carve-out, for the folder five tools read (DOR-1924)'
  - 'feat(config): global scope remembers which tools it shares with (DOR-1924)'
  - "feat(harness): a global package's skills reach the folders your tools read (DOR-1924)"
  - 'feat(cli): DorkOS asks once before it puts a link in your home folder (DOR-1924)'
  - 'test(harness): the J-07 journey, and the case that guards what a DorkOS session still gets (DOR-1924)'
---

### Added

- A package you installed for all your projects can now be shared with your other agent tools. Run `dorkos harness sync --global` and DorkOS asks once: it shows the two folders in your home directory it would use, names every link it would add, and writes nothing until you answer. Say yes with `dorkos harness global --enable <tool>`, once per tool you want (DOR-1924)
- `dorkos harness global --list` shows what you chose and where the links go. `--disable <tool>` stops sharing with one tool and removes the links that tool's folder no longer needs first. Five tools share one folder, so turning one off while another still reads it removes nothing (DOR-1924)
- DorkOS only ever creates links in those two folders, never files, and it only ever removes a link it made itself. Your own skills, and shortcuts you made yourself with the same shape, are left exactly where they are. If you uninstall a package later, DorkOS removes its links too (DOR-1924)

### Changed

- If you told DorkOS to stay inside one folder on this machine, it does not put links in your home directory. It says so, names the folder you set, and your timed skills keep running (DOR-1924)
- Saying no is remembered. DorkOS asks the question once, and a no means it does not ask again (DOR-1924)
