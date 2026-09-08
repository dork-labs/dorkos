---
covers:
  - 'feat(harness,cli): a harness added later, and gitignore lines (DOR-1851)'
  - 'docs(harness,cli): the one manifest write path, and gitignore (DOR-1851)'
---

### Added

- `dorkos harness sync` now looks at which coding agents your project uses every time you run it. Start using Cursor next month and it tells you Cursor is not turned on yet, instead of quietly leaving it out (DOR-1851).
- `dorkos harness sync --fix --enable cursor` turns an agent on and sets it up in one command. It is the only thing that writes to your `.agents/harness.manifest.json`, and all it does is add the name to the list — your own formatting and key order stay exactly as you left them (DOR-1851).
- Some of what DorkOS writes belongs to your computer rather than your project: links into installed packages, and the hooks files it rebuilds on every sync. If your `.gitignore` does not cover them, `dorkos harness sync` now prints the exact lines to add, and `--fix --write-gitignore` adds them for you. It only ever appends, under a comment saying where the lines came from (DOR-1851).
- If you keep `.agents/` out of git, `dorkos harness sync` explains what that means: your skills stay on this computer, while the links DorkOS writes into `.claude/skills` still get committed — so anyone who clones your project gets links pointing at files they do not have (DOR-1851).
