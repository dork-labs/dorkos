### Added

- Agents can now drive the workbench: three `control_ui` actions — `open_file` (open a file in the right-panel viewer), `open_terminal` (reveal the terminal in the session's worktree), and `browser_navigate` (open a page in the embedded browser). Works on both Claude Code and Codex; `open_terminal` degrades gracefully where terminals aren't available (DOR-215).
