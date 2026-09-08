---
covers:
  - 'fix(harness): a clone without symlinks is told so in one line (DOR-1855)'
  - 'fix(harness): Windows spells a path one way, not half of each (DOR-1855)'
---

### Fixed

- `dorkos harness sync` now explains a checkout that cannot make symlinks. On Windows, and in any clone where symlinks are turned off, git writes each skill link out as a plain file — and the report used to call that "drift" and tell you to run `--fix`, which then refused it without saying why. It now says in one line that symlinks are off in this checkout, and gives you both ways out (DOR-1855).
- Every blocked skill link now says what is in the way, not just that something is. When the name on disk differs only in case — a `Foo` where the plan wants `foo`, on a Mac or Windows filesystem that does not tell the two apart — the message names the difference, instead of leaving you looking at a folder you believe is called something else (DOR-1855).
- On Windows, the file paths DorkOS writes into a plugin's hooks and command wrappers are now spelled one consistent way instead of half one way and half the other, which is easier to read and safer for the shell that runs them (DOR-1855).
