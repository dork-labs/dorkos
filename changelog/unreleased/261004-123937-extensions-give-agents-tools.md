---
covers:
  - 'feat(extensions): declare agent tools and skills in extension.json (DOR-2685)'
  - 'feat(extensions): accept only listable tool input schemas (DOR-2685)'
  - 'feat(extensions): bind tool handlers through ctx.tools and register them at load (DOR-2685)'
  - 'chore(extensions): fit the tools reference, fix test types, regenerate the API document (DOR-2685)'
  - 'docs(extensions): document extension tools for authors and people (DOR-2685)'
  - 'fix(extensions): one start or stop at a time per extension (DOR-2685)'
  - "fix(extensions): list_extensions shows each tool's status and reason (DOR-2685)"
  - 'fix(extensions): one tool check for discovery, contribute and marketplace validate (DOR-2685)'
  - 'fix(extensions): redact every path shape from a tool error (DOR-2685)'
  - 'feat(claude-code): relaunch a warm process whose dorkos tool list changed (DOR-2685)'
  - 'test(claude-code): pin the warm-process tool-surface relaunch through dispatch (DOR-2685)'
  - 'test(extensions): guard extension tools in every agent tool list (DOR-2685)'
  - 'docs(extensions): say when each agent sees an extension tool change (DOR-2685)'
---

### Added

- Extensions can now give your agents tools. An extension you approved offers its tools while it runs, and they go away when you turn it off, stop it or remove it. Each tool sits in the **Extension tools** permission area, and one that deletes something asks you every time. Codex and OpenCode chats get new tools the next time they ask DorkOS for its tool list, and a Claude Code chat gets them with your next message (DOR-2685)
- Removing an extension clears any permission you set for its tools, so a choice like Allowed never carries over to something installed later under the same name (DOR-2685)
- `dorkos marketplace validate` now checks the extensions a package carries, and fails when DorkOS would refuse one of their tools, so an author hears about it before publishing (DOR-2685)
