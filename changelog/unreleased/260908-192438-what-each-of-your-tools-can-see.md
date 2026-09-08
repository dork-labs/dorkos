---
covers:
  - 'feat(server): GET /api/harness/status, read-only (DOR-1892)'
  - 'feat(server): manifest notices reach the status payload (DOR-1892, DOR-1906)'
---

### Added

- DorkOS can now be asked, for any folder, what each of your coding tools can actually see there — every skill, command, rule and hook, and whether Claude Code, Codex, Cursor, Gemini, Copilot and OpenCode get it, miss it, or are out of date. Asking only looks: it never creates a file, never turns a tool on, and never changes a setting of yours. A folder you have not set up yet says so plainly rather than failing. This is the answer the Skills page will draw; nothing in the app asks for it yet, so there is nothing new to click (DOR-1892)
- The same answer also says what is wrong with the file that lists which tools a project shares its agent files with — a setting that is no longer read, or a rule written for a tool the project does not use. It says it in exactly the words `dorkos harness sync` prints in your terminal, so the two can never tell you different things about the same file (DOR-1892, DOR-1906)
